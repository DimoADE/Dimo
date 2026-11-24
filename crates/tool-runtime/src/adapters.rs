use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use reqwest::header::LOCATION;
use url::Url;

use crate::{Downloader, PortError, validate_distribution_url};

#[derive(Clone)]
pub struct HttpDownloader {
    resolver: Arc<dyn HostResolver>,
    connect_timeout: Duration,
    request_timeout: Duration,
    max_bytes: usize,
}

impl HttpDownloader {
    pub fn new(connect_timeout: Duration, request_timeout: Duration) -> Self {
        Self::with_resolver(
            Arc::new(SystemHostResolver),
            connect_timeout,
            request_timeout,
            256 * 1024 * 1024,
        )
    }

    pub fn with_resolver(
        resolver: Arc<dyn HostResolver>,
        connect_timeout: Duration,
        request_timeout: Duration,
        max_bytes: usize,
    ) -> Self {
        Self {
            resolver,
            connect_timeout,
            request_timeout,
            max_bytes,
        }
    }
}

#[async_trait]
pub trait HostResolver: Send + Sync {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, PortError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemHostResolver;

#[async_trait]
impl HostResolver for SystemHostResolver {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, PortError> {
        tokio::net::lookup_host((host, port))
            .await
            .map(|addresses| addresses.map(|address| address.ip()).collect())
            .map_err(|_| PortError::new("download host resolution failed"))
    }
}

#[async_trait]
impl Downloader for HttpDownloader {
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, PortError> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        validate_distribution_url(url).map_err(PortError::new)?;
        let initial = Url::parse(url).map_err(|_| PortError::new("download URL is invalid"))?;
        let initial_host = initial
            .host_str()
            .ok_or_else(|| PortError::new("download URL must contain a host"))?
            .to_ascii_lowercase();
        let mut current = initial;
        let mut redirect_count = 0_u8;

        let mut response = loop {
            validate_redirect_target(&initial_host, &current, redirect_count)?;
            let host = current
                .host_str()
                .ok_or_else(|| PortError::new("download URL must contain a host"))?;
            let port = current
                .port_or_known_default()
                .ok_or_else(|| PortError::new("download URL port is invalid"))?;
            let addresses = self.resolver.resolve(host, port).await?;
            if addresses.is_empty()
                || addresses
                    .iter()
                    .any(|address| !is_allowed_download_address(host, *address))
            {
                return Err(PortError::new(
                    "download host must resolve only to public IP addresses",
                ));
            }
            let socket_addresses = addresses
                .iter()
                .map(|address| SocketAddr::new(*address, port))
                .collect::<Vec<_>>();
            let client = reqwest::Client::builder()
                .https_only(true)
                .user_agent(DOWNLOAD_USER_AGENT)
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(self.connect_timeout)
                .timeout(self.request_timeout)
                .resolve_to_addrs(host, &socket_addresses)
                .build()
                .map_err(|_| PortError::new("secure HTTPS client setup failed"))?;
            let response = client
                .get(current.clone())
                .send()
                .await
                .map_err(|_| PortError::new("HTTPS download failed"))?;
            if !response.status().is_redirection() {
                break response;
            }
            if redirect_count >= 5 {
                return Err(PortError::new("download redirect limit exceeded"));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| PortError::new("download redirect is missing a valid location"))?;
            current = current
                .join(location)
                .map_err(|_| PortError::new("download redirect location is invalid"))?;
            redirect_count += 1;
        };

        response = match response.error_for_status() {
            Ok(response) => response,
            Err(error) => {
                return Err(PortError::new(match error.status() {
                    Some(status) => format!("HTTPS download returned HTTP {}", status.as_u16()),
                    None => "HTTPS download returned an error status".to_owned(),
                }));
            }
        };
        if response
            .content_length()
            .is_some_and(|length| length > self.max_bytes as u64)
        {
            return Err(PortError::new("download exceeds the configured size limit"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| PortError::new("HTTPS download body failed"))?
        {
            if bytes.len().saturating_add(chunk.len()) > self.max_bytes {
                return Err(PortError::new("download exceeds the configured size limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

const DOWNLOAD_USER_AGENT: &str = "Dimo";

fn validate_redirect_target(
    initial_host: &str,
    target: &Url,
    redirect_count: u8,
) -> Result<(), PortError> {
    let host = target
        .host_str()
        .ok_or_else(|| PortError::new("download redirect must contain a DNS host"))?;
    let normalized_host = host.trim_end_matches('.').to_ascii_lowercase();
    let credentials_are_empty = target.username().is_empty() && target.password().is_none();
    let standard_https_port = target.port_or_known_default() == Some(443);
    if target.scheme() != "https"
        || normalized_host.len() != host.len()
        || !credentials_are_empty
        || target.fragment().is_some()
        || !standard_https_port
    {
        return Err(PortError::new("download redirect target is not allowed"));
    }
    if redirect_count == 0 {
        return Ok(());
    }
    let trusted_github_release = initial_host == "github.com"
        && matches!(
            normalized_host.as_str(),
            "github.com" | "release-assets.githubusercontent.com"
        );
    let trusted_mirror_redirect = normalized_host == initial_host
        || (initial_host == "npmmirror.com"
            && matches!(
                normalized_host.as_str(),
                "npmmirror.com" | "cdn.npmmirror.com"
            ));
    if !trusted_github_release && !trusted_mirror_redirect {
        return Err(PortError::new("download redirect target is not allowed"));
    }
    Ok(())
}

fn is_allowed_download_address(host: &str, address: IpAddr) -> bool {
    is_public_ip(address)
        || (is_trusted_proxy_download_host(host) && is_proxy_synthetic_ip(address))
}

fn is_trusted_proxy_download_host(host: &str) -> bool {
    matches!(
        host.trim_end_matches('.').to_ascii_lowercase().as_str(),
        "github.com"
            | "release-assets.githubusercontent.com"
            | "nodejs.org"
            | "mirror.dimo-ai.com"
            | "cdn.npmmirror.com"
            | "npmmirror.com"
    )
}

fn is_proxy_synthetic_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [a, b, _, _] = address.octets();
            a == 198 && (b == 18 || b == 19)
        }
        IpAddr::V6(_) => false,
    }
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    if let Some(address) = address.to_ipv4_mapped() {
        return is_public_ipv4(address);
    }
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_azure_sas_query_round_trips_through_url() {
        let location = concat!(
            "https://release-assets.githubusercontent.com/github-production-release-asset/1/abc",
            "?sp=r&sig=ab%2Bcd%3D&rscd=attachment%3B+filename%3Dapp.exe&se=2026-09-21T15%3A53%3A30Z"
        );
        let parsed = Url::parse(location).expect("SAS Location must parse");
        assert_eq!(
            parsed.as_str(),
            location,
            "Url serialization must keep Azure SAS percent-encoding"
        );
    }
}
