const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  isWindowsInstallerArtifact,
  resolveSigningMode,
  shouldEvsignFile,
} = require("../electron/build/signWindows");
const {
  appendPublisherNameToUpdateConfig,
  collectSidecarBinaries,
  ensureUnixSidecarPermissions,
  ensureWindowsEvsignPublisherName,
  parsePublisherNameEnv,
  resolveMacSigningIdentity,
  signMacSidecars,
} = require("../electron/build/afterPack");

const ROOT = path.join(__dirname, "..");
const ELECTRON_DIR = path.join(ROOT, "electron");
const BUILD_DIR = path.join(ELECTRON_DIR, "build");
const ICONS_DIR = path.join(BUILD_DIR, "icons");

test("Electron builder config wires icons, DMG background, NSIS hook, Windows EVSign hook, macOS media descriptions, Linux executableName, and CLI-driven target arches", () => {
  const builderYml = fs.readFileSync(
    path.join(ELECTRON_DIR, "electron-builder.yml"),
    "utf8",
  );
  assert.match(builderYml, /from:\s+build\/icons/);
  assert.match(builderYml, /icon:\s+build\/icons\/icon\.ico/);
  assert.match(builderYml, /icon:\s+build\/icons\/icon\.icns/);
  assert.match(builderYml, /icon:\s+build\/icons\/128x128@2x\.png/);
  assert.match(builderYml, /script:\s+build\/installer\.nsi/);
  assert.match(builderYml, /include:\s+build\/installer\.nsh/);
  assert.match(
    builderYml,
    /installerLanguages:[\s\S]*?-\s+en_US[\s\S]*?-\s+zh_CN/,
    "nsis.installerLanguages must restrict language tables to en_US and zh_CN for custom LangStrings",
  );
  assert.match(builderYml, /background:\s+build\/dmg-background\.png/);
  assert.match(builderYml, /afterPack:\s+\.\/build\/afterPack\.js/);
  assert.match(builderYml, /afterSign:\s+\.\/build\/afterSign\.js/);
  assert.match(builderYml, /signtoolOptions:/);
  assert.match(builderYml, /sign:\s+\.\/build\/signWindows\.js/);
  assert.match(builderYml, /NSMicrophoneUsageDescription:/);
  assert.match(builderYml, /NSCameraUsageDescription:/);
  assert.match(
    builderYml,
    /mac:[\s\S]*?^\s+notarize:\s+false\s*$/m,
    "mac.notarize must be false so app-builder-lib delegates notarization to afterSign.js",
  );
  assert.match(
    builderYml,
    /linux:[\s\S]*?^\s+executableName:\s+dimo\s*$/m,
    "linux.executableName must be set to dimo",
  );
  assert.doesNotMatch(
    builderYml,
    /^\s+arch:/m,
    "electron-builder.yml targets must not hardcode arch arrays; CLI flags drive architecture",
  );
  assert.doesNotMatch(
    builderYml,
    /src-tauri/,
    "electron-builder.yml must not reference removed src-tauri assets",
  );
});

test("Electron packaging assets and hook scripts exist", () => {
  for (const rel of [
    "icons/icon.ico",
    "icons/icon.icns",
    "icons/128x128@2x.png",
    "icons/icon.png",
    "dmg-background.png",
    "installer.nsi",
    "installer.nsh",
    "installer/hooks.nsh",
    "installer/theme.nsh",
    "installer/drawing.nsh",
    "installer/pages.nsh",
    "installer/strings.nsh",
    "entitlements.mac.plist",
    "afterPack.js",
    "afterSign.js",
    "signWindows.js",
  ]) {
    const filePath = path.join(BUILD_DIR, rel);
    assert.ok(fs.existsSync(filePath), `missing packaging asset ${rel}`);
    assert.ok(fs.statSync(filePath).size > 0, `empty packaging asset ${rel}`);
  }
  for (const theme of ["light", "dark"]) {
    for (const size of [48, 60, 64, 72, 80, 96, 128]) {
      const bmpRel = `installer/assets/icon-${theme}-${size}.bmp`;
      const bmpPath = path.join(BUILD_DIR, bmpRel);
      assert.ok(fs.existsSync(bmpPath), `missing installer icon bitmap ${bmpRel}`);
      assert.ok(fs.statSync(bmpPath).size > 0, `empty installer icon bitmap ${bmpRel}`);
    }
  }
  assert.ok(fs.existsSync(path.join(ICONS_DIR, "32x32.png")));
  assert.ok(
    fs.existsSync(path.join(ROOT, "scripts", "generate-installer-assets.py")),
    "missing scripts/generate-installer-assets.py",
  );

  const installerNsi = fs.readFileSync(
    path.join(BUILD_DIR, "installer.nsi"),
    "utf8",
  );
  assert.match(installerNsi, /^ManifestDPIAware\s+true\s*$/m);
  assert.match(installerNsi, /^ManifestDPIAwareness\s+PerMonitorV2\s*$/m);
  assert.match(installerNsi, /Page\s+custom\s+DimoPageMain\s+DimoPageMainLeave/);
  assert.match(installerNsi, /Page\s+custom\s+DimoPageFinish\s+DimoPageFinishLeave/);
  assert.match(
    installerNsi,
    /UninstPage\s+custom\s+un\.DimoPageConfirm\s+un\.DimoPageConfirmLeave/,
  );
  assert.match(installerNsi, /Nsis7z::ExtractWithCallback/);
  assert.match(installerNsi, /WriteUninstaller\s+"\$INSTDIR\\\$\{UNINSTALL_FILENAME\}"/);
  assert.match(installerNsi, /Software\\Classes\\dimo/);

  const entitlements = fs.readFileSync(
    path.join(BUILD_DIR, "entitlements.mac.plist"),
    "utf8",
  );
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(entitlements, /com\.apple\.security\.device\.camera/);

  const afterSignSource = fs.readFileSync(
    path.join(BUILD_DIR, "afterSign.js"),
    "utf8",
  );
  assert.match(afterSignSource, /await\s+import\(['"]@electron\/notarize['"]\)/);
  assert.doesNotMatch(afterSignSource, /require\(['"]@electron\/notarize['"]\)/);

  const electronPkg = JSON.parse(
    fs.readFileSync(path.join(ELECTRON_DIR, "package.json"), "utf8"),
  );
  assert.match(
    electronPkg.homepage || "",
    /^https:\/\//,
    "electron/package.json must specify homepage for Linux .deb packaging",
  );
});

test("Windows NSIS custom hook scopes staged companion termination to $INSTDIR and guards HKLM cleanup", () => {
  const nsh = fs.readFileSync(path.join(BUILD_DIR, "installer.nsh"), "utf8");
  assert.match(nsh, /dimo-server\.exe/);
  assert.match(nsh, /dimo-mcp\.exe/);
  assert.doesNotMatch(nsh, /dimo-workflow-mcp\.exe/);
  assert.doesNotMatch(nsh, /dimo-computer-helper\.exe/);
  assert.doesNotMatch(
    nsh,
    /taskkill\s+\/F\s+\/IM\s+dimo-server\.exe/i,
    "installer.nsh must not unconditionally kill unrelated dimo-server.exe processes",
  );
  assert.match(nsh, /\$INSTDIR/);
  assert.match(nsh, /Win32_Process/);
  assert.match(
    nsh,
    /Wait-Process\s+-Id\s+\$\$pids\s+-Timeout\s+\d+/,
    "stopStagedSidecars must wait for terminated sidecar PIDs to release file locks",
  );
  assert.match(nsh, /customCheckAppRunning/);
  assert.match(
    nsh,
    /^!include\s+"getProcessInfo\.nsh"\s*$/m,
    "installer.nsh must include getProcessInfo.nsh when overriding customCheckAppRunning and calling _CHECK_APP_RUNNING",
  );
  assert.match(
    nsh,
    /^Var\s+pid\s*$/m,
    "installer.nsh must declare Var pid when overriding customCheckAppRunning and calling _CHECK_APP_RUNNING",
  );
  assert.doesNotMatch(
    nsh,
    /!macro\s+customInit\b/,
    "installer.nsh must not kill sidecars in customInit before user confirmation",
  );
  assert.match(
    nsh,
    /SetEnvironmentVariable\(t\s+"DIMO_NSIS_INSTDIR",\s+i\s+0\)/,
    "installer.nsh must clear DIMO_NSIS_INSTDIR after use",
  );
  assert.match(nsh, /customUnInit/);
  assert.match(
    nsh,
    /\$\{if\}\s+\$installMode\s+==\s+"all"[\s\S]*?DeleteRegKey\s+HKLM/,
    "HKLM uninstall registry cleanup must be guarded by per-machine installMode",
  );
});

test("Windows NSIS installer decouples 7z extraction errors from $INSTDIR locks and pre-creates error buttons on the UI thread", () => {
  const installerNsi = fs.readFileSync(
    path.join(BUILD_DIR, "installer.nsi"),
    "utf8",
  );
  const pagesNsh = fs.readFileSync(
    path.join(BUILD_DIR, "installer", "pages.nsh"),
    "utf8",
  );

  const extractIdx = installerNsi.indexOf("dimo_extract_retry:");
  const copyIdx = installerNsi.indexOf("dimo_copy_loop:");
  const copyDoneIdx = installerNsi.indexOf("dimo_copy_done:");
  assert.ok(extractIdx >= 0 && copyIdx > extractIdx && copyDoneIdx > copyIdx);

  const extractBlock = installerNsi.slice(extractIdx, copyIdx);
  const copyBlock = installerNsi.slice(copyIdx, copyDoneIdx);

  // Extraction verification must never restore/create $INSTDIR before checking
  // Nsis7z errors, or a locked/delete-pending $INSTDIR triggers false 0xE0010001 at 87%.
  assert.doesNotMatch(
    extractBlock,
    /SetOutPath\s+["']?\$INSTDIR/i,
    "dimo_extract_retry must not touch $INSTDIR before checking 7z extraction errors",
  );
  assert.doesNotMatch(
    extractBlock,
    /Pop\s+\$R0\s*\r?\n\s*SetOutPath\s+\$R0/,
    "dimo_extract_retry must not restore $OUTDIR ($INSTDIR) before checking ${Errors}",
  );
  assert.match(
    extractBlock,
    /Nsis7z::ExtractWithCallback[\s\S]*?\$\{If\}\s+\$\{Errors\}[\s\S]*?0xE0010001/,
  );

  // $INSTDIR creation/copy retries happen inside dimo_copy_loop with process check + 0xE0010002.
  assert.match(copyBlock, /SetOutPath\s+"\$INSTDIR"/);
  assert.match(copyBlock, /Call\s+DimoCheckAppRunning/);
  assert.match(copyBlock, /CopyFiles\s+\/SILENT/);
  assert.match(copyBlock, /0xE0010002/);

  // Uninstaller atomicRMDir must match leading backslash for self-uninstaller and guard cross-drive renames.
  assert.match(
    installerNsi,
    /StrCmp\s+"\$R0\\\$R2"\s+"\\\$\{UNINSTALL_FILENAME\}"/,
  );
  assert.match(
    installerNsi,
    /StrCpy\s+\$R1\s+\$INSTDIR\s+2[\s\S]*?StrCpy\s+\$R2\s+\$PLUGINSDIR\s+2[\s\S]*?\$\{If\}\s+\$R1\s+==\s+\$R2[\s\S]*?Call\s+un\.atomicRMDir/,
  );

  // Error footer buttons must be created in DimoInstFilesShow (UI thread), not DimoShowError (worker thread).
  const instFilesStart = pagesNsh.indexOf("Function ${UN}DimoInstFilesShow");
  const instFilesEnd = pagesNsh.indexOf("FunctionEnd", instFilesStart);
  const instFilesBody = pagesNsh.slice(instFilesStart, instFilesEnd);
  assert.match(instFilesBody, /DimoMakeStatic\s+\$DimoLogBtn\s+\$DimoInstDlg/);
  assert.match(instFilesBody, /DimoMakeStatic\s+\$DimoErrCancel\s+\$DimoInstDlg/);
  assert.match(instFilesBody, /DimoMakeStatic\s+\$DimoRetryBtn\s+\$DimoInstDlg/);

  const showErrorStart = pagesNsh.indexOf("Function DimoShowError");
  const showErrorEnd = pagesNsh.indexOf("FunctionEnd", showErrorStart);
  const showErrorBody = pagesNsh.slice(showErrorStart, showErrorEnd);
  assert.doesNotMatch(
    showErrorBody,
    /DimoMakeStatic\s+\$(DimoLogBtn|DimoErrCancel|DimoRetryBtn)/,
    "DimoShowError runs on the section worker thread and must not create child static windows",
  );
  assert.doesNotMatch(
    showErrorBody,
    /SetDetailsPrint\s+both/,
    "dimo_err_retry should keep SetDetailsPrint none",
  );
});

test("signWindows resolves evsign, signtool, and unsigned modes cleanly and limits EVSign to installers by default", () => {
  assert.equal(
    resolveSigningMode({ cscInfo: null }, { EVSIGN_LICENSE_KEY: "license-key" }),
    "evsign",
  );
  assert.equal(
    resolveSigningMode(
      { cscInfo: { file: "cert.pfx", password: "secret" } },
      {},
    ),
    "signtool",
  );
  assert.equal(resolveSigningMode({ cscInfo: null }, {}), "unsigned");

  assert.equal(
    isWindowsInstallerArtifact("electron/release/Dimo-0.5.3-windows-x64-setup.exe"),
    true,
  );
  assert.equal(
    isWindowsInstallerArtifact("electron/release/Dimo-0.5.3-windows-arm64-setup.exe"),
    true,
  );
  assert.equal(
    isWindowsInstallerArtifact("electron/release/Dimo-0.5.3-windows-x64.msi"),
    true,
  );
  assert.equal(
    isWindowsInstallerArtifact("electron/release/win-unpacked/Dimo.exe"),
    false,
  );
  assert.equal(
    isWindowsInstallerArtifact(
      "electron/release/win-unpacked/resources/bin/dimo-server.exe",
    ),
    false,
  );
  assert.equal(
    isWindowsInstallerArtifact("electron/release/__uninstaller-nsis-dimo.exe"),
    false,
  );

  assert.equal(
    shouldEvsignFile("electron/release/Dimo-0.5.3-windows-x64-setup.exe", {}),
    true,
  );
  assert.equal(
    shouldEvsignFile(
      "electron/release/win-unpacked/resources/bin/dimo-server.exe",
      {},
    ),
    false,
  );
  assert.equal(
    shouldEvsignFile(
      "electron/release/win-unpacked/resources/bin/dimo-server.exe",
      { EVSIGN_SIGN_INNER_BINARIES: "1" },
    ),
    true,
  );
});

test("afterPack resolves macOS signing identity from APPLE_SIGNING_IDENTITY or CSC_NAME", () => {
  assert.equal(
    resolveMacSigningIdentity({
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Dimo Inc (ABC123)",
      CSC_NAME: "Other (XYZ)",
    }),
    "Developer ID Application: Dimo Inc (ABC123)",
  );
  assert.equal(
    resolveMacSigningIdentity({ CSC_NAME: "Dimo Inc (ABC123)" }),
    "Developer ID Application: Dimo Inc (ABC123)",
  );
  assert.equal(
    resolveMacSigningIdentity({
      CSC_NAME: "Developer ID Application: Dimo Inc (ABC123)",
    }),
    "Developer ID Application: Dimo Inc (ABC123)",
  );
  assert.equal(
    resolveMacSigningIdentity({
      CSC_NAME: "0123456789abcdef0123456789abcdef01234567",
    }),
    "0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(resolveMacSigningIdentity({ CSC_NAME: "-" }), "-");
  assert.equal(resolveMacSigningIdentity({}), null);
});

test("afterPack recursively chmods macOS and Linux sidecars even when unsigned and signs dylibs before binaries on macOS", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dimo-afterpack-unix-"));
  try {
    const macBinDir = path.join(
      tmpDir,
      "mac-out",
      "Dimo.app",
      "Contents",
      "Resources",
      "bin",
    );
    const macNestedDir = path.join(macBinDir, "nested");
    fs.mkdirSync(macNestedDir, { recursive: true });
    const serverBin = path.join(macBinDir, "dimo-server");
    const nestedHelper = path.join(macNestedDir, "helper-tool");
    const nestedDylib = path.join(macNestedDir, "libhelper.dylib");
    const readmeFile = path.join(macBinDir, "README.txt");
    fs.writeFileSync(serverBin, "stub-server");
    fs.writeFileSync(nestedHelper, "stub-helper");
    fs.writeFileSync(nestedDylib, "stub-dylib");
    fs.writeFileSync(readmeFile, "not-a-binary");

    assert.deepEqual(collectSidecarBinaries(macBinDir), [
      nestedDylib,
      serverBin,
      nestedHelper,
    ]);

    const macContext = {
      electronPlatformName: "darwin",
      appOutDir: path.join(tmpDir, "mac-out"),
      packager: { appInfo: { productFilename: "Dimo" } },
    };

    // Unsigned macOS build must still chmod all staged binaries/dylibs recursively
    const unsignedChmods = [];
    const unsignedCodesigns = [];
    signMacSidecars(macContext, {
      env: {},
      chmod: (filePath, mode) => unsignedChmods.push([filePath, mode]),
      execFile: (...args) => unsignedCodesigns.push(args),
    });
    assert.deepEqual(unsignedChmods, [
      [nestedDylib, 0o755],
      [serverBin, 0o755],
      [nestedHelper, 0o755],
    ]);
    assert.equal(unsignedCodesigns.length, 0);

    // Signed macOS build via CSC_NAME signs dylib first (without entitlements), then executables (with runtime + entitlements)
    const signedCalls = [];
    signMacSidecars(macContext, {
      env: { CSC_NAME: "Dimo Inc (TEAM123)" },
      chmod: () => {},
      execFile: (cmd, args) => signedCalls.push({ cmd, args }),
    });
    assert.equal(signedCalls.length, 3);
    assert.equal(signedCalls[0].cmd, "codesign");
    assert.equal(signedCalls[0].args.at(-1), nestedDylib);
    assert.ok(
      signedCalls[0].args.includes("Developer ID Application: Dimo Inc (TEAM123)"),
    );
    assert.ok(!signedCalls[0].args.includes("--entitlements"));
    assert.equal(signedCalls[1].args.at(-1), serverBin);
    assert.ok(signedCalls[1].args.includes("--entitlements"));
    assert.ok(signedCalls[1].args.includes("runtime"));
    assert.equal(signedCalls[2].args.at(-1), nestedHelper);
    assert.ok(signedCalls[2].args.includes("--entitlements"));

    // Linux build recursively chmods resources/bin sidecars
    const linuxBinDir = path.join(tmpDir, "linux-out", "resources", "bin");
    const linuxNestedDir = path.join(linuxBinDir, "sub");
    fs.mkdirSync(linuxNestedDir, { recursive: true });
    const linuxServer = path.join(linuxBinDir, "dimo-server");
    const linuxLib = path.join(linuxNestedDir, "libfoo.so.1");
    fs.writeFileSync(linuxServer, "stub-linux-server");
    fs.writeFileSync(linuxLib, "stub-linux-so");

    const linuxChmods = [];
    ensureUnixSidecarPermissions(
      {
        electronPlatformName: "linux",
        appOutDir: path.join(tmpDir, "linux-out"),
      },
      { chmod: (filePath, mode) => linuxChmods.push([filePath, mode]) },
    );
    assert.deepEqual(linuxChmods, [
      [linuxLib, 0o755],
      [linuxServer, 0o755],
    ]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("afterPack injects Windows EVSign publisherName into app-update.yml", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dimo-afterpack-"));
  try {
    const resourcesDir = path.join(tmpDir, "resources");
    const binDir = path.join(resourcesDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "dimo-server.exe"), "stub-signed-exe");
    const appUpdatePath = path.join(resourcesDir, "app-update.yml");
    fs.writeFileSync(
      appUpdatePath,
      "owner: DimoADE\nrepo: Dimo\nprovider: github\n",
      "utf8",
    );

    // Skips when EVSIGN_LICENSE_KEY is absent (unsigned or PFX build)
    assert.equal(
      ensureWindowsEvsignPublisherName(
        { electronPlatformName: "win32", appOutDir: tmpDir },
        { env: {} },
      ),
      false,
    );

    // Injects full DN read from signed sidecar when EVSIGN_LICENSE_KEY is set
    const subjectDn = 'CN="Dimo, Inc.", O="Dimo, Inc.", L=Shanghai, C=CN';
    assert.equal(
      ensureWindowsEvsignPublisherName(
        { electronPlatformName: "win32", appOutDir: tmpDir },
        {
          env: { EVSIGN_LICENSE_KEY: "ev-key" },
          readSubject: (filePath) => {
            assert.equal(filePath, path.join(binDir, "dimo-server.exe"));
            return subjectDn;
          },
        },
      ),
      true,
    );
    const updated = fs.readFileSync(appUpdatePath, "utf8");
    assert.ok(updated.includes("publisherName:\n"));
    assert.ok(updated.includes(`  - ${JSON.stringify(subjectDn)}\n`));

    // Does not duplicate publisherName if already present
    assert.equal(
      ensureWindowsEvsignPublisherName(
        { electronPlatformName: "win32", appOutDir: tmpDir },
        {
          env: { EVSIGN_LICENSE_KEY: "ev-key" },
          readSubject: () => {
            throw new Error("should not be called when publisherName exists");
          },
        },
      ),
      false,
    );

    assert.deepEqual(parsePublisherNameEnv("CN=Dimo"), ["CN=Dimo"]);
    assert.deepEqual(parsePublisherNameEnv('["CN=Dimo A","CN=Dimo B"]'), [
      "CN=Dimo A",
      "CN=Dimo B",
    ]);
    assert.equal(
      appendPublisherNameToUpdateConfig(
        "provider: github\npublisherName:\n  - Existing\n",
        ["Ignored"],
      ),
      "provider: github\npublisherName:\n  - Existing\n",
    );

    // Installer-only EVSign skips unsigned sidecar derivation when EVSIGN_PUBLISHER_NAME is unset
    fs.writeFileSync(
      appUpdatePath,
      "owner: DimoADE\nrepo: Dimo\nprovider: github\n",
      "utf8",
    );
    assert.equal(
      ensureWindowsEvsignPublisherName(
        { electronPlatformName: "win32", appOutDir: tmpDir },
        {
          env: { EVSIGN_LICENSE_KEY: "ev-key" },
          readSubject: () => {
            throw new Error("Expected valid Authenticode signature, got NotSigned");
          },
        },
      ),
      false,
    );

    // Strict mode throws if EVSIGN_SIGN_INNER_BINARIES=1 and sidecar is unsigned
    assert.throws(
      () =>
        ensureWindowsEvsignPublisherName(
          { electronPlatformName: "win32", appOutDir: tmpDir },
          {
            env: {
              EVSIGN_LICENSE_KEY: "ev-key",
              EVSIGN_SIGN_INNER_BINARIES: "1",
            },
            readSubject: () => {
              throw new Error(
                "Expected valid Authenticode signature, got NotSigned",
              );
            },
          },
        ),
      /NotSigned/,
    );

    // Explicit EVSIGN_PUBLISHER_NAME works even when sidecar is unsigned
    assert.equal(
      ensureWindowsEvsignPublisherName(
        { electronPlatformName: "win32", appOutDir: tmpDir },
        {
          env: {
            EVSIGN_LICENSE_KEY: "ev-key",
            EVSIGN_PUBLISHER_NAME: "CN=Dimo",
          },
          readSubject: () => {
            throw new Error(
              "should not inspect sidecar when EVSIGN_PUBLISHER_NAME is set",
            );
          },
        },
      ),
      true,
    );
    assert.ok(
      fs
        .readFileSync(appUpdatePath, "utf8")
        .includes('publisherName:\n  - "CN=Dimo"\n'),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Windows NSIS installer requires \\Dimo separator on Browse and rejects roots, relative paths, and non-empty foreign directories", () => {
  const pagesNsh = fs.readFileSync(
    path.join(BUILD_DIR, "installer", "pages.nsh"),
    "utf8",
  );
  const stringsNsh = fs.readFileSync(
    path.join(BUILD_DIR, "installer", "strings.nsh"),
    "utf8",
  );

  // DimoOnBrowse strips trailing backslashes and checks for `\${PRODUCT_NAME}` (not bare `${PRODUCT_NAME}`).
  const browseStart = pagesNsh.indexOf("Function DimoOnBrowse");
  const browseEnd = pagesNsh.indexOf("FunctionEnd", browseStart);
  assert.ok(browseStart >= 0 && browseEnd > browseStart);
  const browseBody = pagesNsh.slice(browseStart, browseEnd);
  assert.match(browseBody, /StrLen\s+\$DimoT2\s+"\\\$\{PRODUCT_NAME\}"/);
  assert.match(browseBody, /\$\{If\}\s+\$DimoT3\s+!=\s+"\\\$\{PRODUCT_NAME\}"/);
  assert.doesNotMatch(
    browseBody,
    /\$\{If\}\s+\$DimoT3\s+!=\s+"\$\{PRODUCT_NAME\}"/,
    "DimoOnBrowse must match \\Dimo so paths like C:\\Projects\\MyDimo still append \\Dimo",
  );

  // Mirror DimoOnBrowse normalization semantics on edge-case paths.
  const normalizeBrowsePath = (selected, productName = "Dimo") => {
    let p = selected;
    while (p.endsWith("\\")) p = p.slice(0, -1);
    if (!p) return p;
    const suffix = `\\${productName}`;
    if (!p.toLowerCase().endsWith(suffix.toLowerCase())) {
      p = `${p}${suffix}`;
    }
    return p;
  };
  assert.equal(
    normalizeBrowsePath("C:\\Projects\\MyDimo"),
    "C:\\Projects\\MyDimo\\Dimo",
  );
  assert.equal(normalizeBrowsePath("C:\\Apps\\Dimo\\"), "C:\\Apps\\Dimo");
  assert.equal(normalizeBrowsePath("C:\\Apps\\dimo"), "C:\\Apps\\dimo");
  assert.equal(normalizeBrowsePath("D:\\"), "D:\\Dimo");

  // DimoPageMainLeave rejects drive roots, non-absolute paths, regular files,
  // and existing non-empty directories without Dimo install markers.
  const leaveStart = pagesNsh.indexOf("Function DimoPageMainLeave");
  const leaveEnd = pagesNsh.indexOf("FunctionEnd", leaveStart);
  assert.ok(leaveStart >= 0 && leaveEnd > leaveStart);
  const leaveBody = pagesNsh.slice(leaveStart, leaveEnd);
  assert.match(leaveBody, /kernel32::GetFullPathNameW\(/);
  assert.match(leaveBody, /kernel32::GetDriveTypeW\(/);
  assert.match(leaveBody, /\$\{GetRoot\}\s+"\$DimoT1"\s+\$DimoT3/);
  assert.match(leaveBody, /\$\{OrIf\}\s+\$DimoT2\s+!=\s+":\\"/);
  assert.match(leaveBody, /\$\{OrIf\}\s+\$DimoT5\s+<=\s+3/);
  assert.match(leaveBody, /\$\{OrIf\}\s+\$DimoT1\s+==\s+\$DimoT3/);
  assert.match(
    leaveBody,
    /\$\{IfNot\}\s+\$\{FileExists\}\s+"\$DimoT1\\\$\{APP_EXECUTABLE_FILENAME\}"/,
  );
  assert.match(
    leaveBody,
    /\$\{AndIfNot\}\s+\$\{FileExists\}\s+"\$DimoT1\\\$\{UNINSTALL_FILENAME\}"/,
  );
  assert.match(leaveBody, /FindFirst\s+\$DimoT5\s+\$DimoT6\s+"\$DimoT1\\\*"/);
  assert.match(leaveBody, /FindNext\s+\$DimoT5\s+\$DimoT6/);
  assert.match(leaveBody, /FindClose\s+\$DimoT5/);
  assert.match(leaveBody, /\$\(DIMO_PATH_NOT_EMPTY\)/);
  assert.match(stringsNsh, /!insertmacro\s+DIMO_STR\s+DIMO_PATH_NOT_EMPTY\b/);
});

test("Windows NSIS un.DimoCheckAppRunning avoids self-kill, prefix collisions, and single-quote crashes (E7)", () => {
  const { execFileSync } = require("node:child_process");
  const installerNsi = fs.readFileSync(
    path.join(BUILD_DIR, "installer.nsi"),
    "utf8",
  );

  // un.DimoCheckAppRunning must use our safe directory-scoped helper instead of stock FIND_PROCESS / KILL_PROCESS.
  const unCheckStart = installerNsi.indexOf("Function un.DimoCheckAppRunning");
  const unCheckEnd = installerNsi.indexOf("FunctionEnd", unCheckStart);
  assert.ok(unCheckStart >= 0 && unCheckEnd > unCheckStart);
  const unCheckBody = installerNsi.slice(unCheckStart, unCheckEnd);
  assert.match(unCheckBody, /!insertmacro\s+DimoInitProcessHelpers\b/);
  assert.match(
    unCheckBody,
    /!insertmacro\s+DimoCheckAppRunningInDirBody\s+"\$INSTDIR"\s+"un"/,
  );
  assert.doesNotMatch(unCheckBody, /!insertmacro\s+(FIND_PROCESS|KILL_PROCESS)\b/);

  // Shared find/kill macros must pass paths & self PID via env vars, clear them,
  // enforce trailing backslash prefix boundary, and exclude $PID + ancestor chain.
  const findStart = installerNsi.indexOf("!macro DimoFindRunningInDir");
  const findEnd = installerNsi.indexOf("!macroend", findStart);
  const killStart = installerNsi.indexOf("!macro DimoKillRunningInDir");
  const killEnd = installerNsi.indexOf("!macroend", killStart);
  assert.ok(findStart >= 0 && findEnd > findStart);
  assert.ok(killStart >= 0 && killEnd > killStart);

  for (const [name, macroBody] of [
    ["DimoFindRunningInDir", installerNsi.slice(findStart, findEnd)],
    ["DimoKillRunningInDir", installerNsi.slice(killStart, killEnd)],
  ]) {
    assert.match(
      macroBody,
      /SetEnvironmentVariable\(t\s+"DIMO_NSIS_INSTDIR",\s+t\s+"\$\{dirVar\}"\)/,
      `${name} must pass target directory via DIMO_NSIS_INSTDIR env var`,
    );
    assert.match(
      macroBody,
      /SetEnvironmentVariable\(t\s+"DIMO_NSIS_SELF_PID",\s+t\s+"\$pid"\)/,
      `${name} must pass uninstaller PID via DIMO_NSIS_SELF_PID env var`,
    );
    assert.match(
      macroBody,
      /SetEnvironmentVariable\(t\s+"DIMO_NSIS_INSTDIR",\s+i\s+0\)/,
      `${name} must clear DIMO_NSIS_INSTDIR after use`,
    );
    assert.match(
      macroBody,
      /SetEnvironmentVariable\(t\s+"DIMO_NSIS_SELF_PID",\s+i\s+0\)/,
      `${name} must clear DIMO_NSIS_SELF_PID after use`,
    );
    assert.match(
      macroBody,
      /-ExecutionPolicy\s+Bypass/,
      `${name} must pass -ExecutionPolicy Bypass`,
    );
    assert.match(
      macroBody,
      /\$\$root\.TrimEnd\('\\'\)\s*\+\s*'\\'/,
      `${name} must append trailing backslash to prevent Dimo vs Dimo-dev prefix collisions`,
    );
    assert.match(
      macroBody,
      /ParentProcessId/,
      `${name} must walk ParentProcessId to exclude self and parent uninstaller processes`,
    );
  }

  // On Windows, execute the extracted PowerShell command against a single-quote path
  // and verify the exact prefix-boundary / ancestor-exclusion filter logic executes cleanly.
  if (process.platform === "win32") {
    const findMacro = installerNsi.slice(findStart, findEnd);
    const cmdMatch = findMacro.match(/-Command\s+"([\s\S]*?)"`/);
    assert.ok(cmdMatch, "expected PowerShell -Command snippet in DimoFindRunningInDir");
    const psScript = cmdMatch[1].replace(/\$\$/g, "$");

    const psExe = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );

    let exitCode = 0;
    let stderr = "";
    try {
      execFileSync(
        psExe,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript],
        {
          env: {
            ...process.env,
            DIMO_NSIS_INSTDIR: "C:\\Users\\O'Brien\\AppData\\Local\\Programs\\Dimo",
            DIMO_NSIS_SELF_PID: String(process.pid),
          },
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
        },
      );
    } catch (err) {
      exitCode = err.status;
      stderr = String(err.stderr || "");
    }
    assert.equal(
      exitCode,
      1,
      `single-quote non-existent path must return exit 1 (not running), got ${exitCode} stderr=${stderr}`,
    );
    assert.equal(stderr.trim(), "", "PowerShell command must not emit syntax or runtime errors");

    // Verify prefix boundary & ancestor exclusion on synthetic Win32_Process records.
    const syntheticCheck = [
      `$root = $env:DIMO_NSIS_INSTDIR`,
      `$prefix = $root.TrimEnd('\\') + '\\'`,
      `$procs = @(`,
      `  [pscustomobject]@{ ProcessId = 100; ParentProcessId = 1; ExecutablePath = "C:\\Users\\O'Brien\\Dimo\\Uninstall Dimo.exe" },`,
      `  [pscustomobject]@{ ProcessId = 101; ParentProcessId = 100; ExecutablePath = "C:\\Users\\O'Brien\\Dimo\\Uninstall Dimo.exe" },`,
      `  [pscustomobject]@{ ProcessId = 200; ParentProcessId = 1; ExecutablePath = "C:\\Users\\O'Brien\\Dimo-dev\\Dimo.exe" },`,
      `  [pscustomobject]@{ ProcessId = 300; ParentProcessId = 1; ExecutablePath = "C:\\Users\\O'Brien\\Dimo\\Dimo.exe" }`,
      `)`,
      `$exclude = New-Object 'System.Collections.Generic.HashSet[int]'`,
      `$selfPid = 0; [void][int]::TryParse($env:DIMO_NSIS_SELF_PID, [ref]$selfPid)`,
      `foreach ($seed in @([int]$PID, $selfPid)) { $cur = $seed; while ($cur -gt 0 -and $exclude.Add($cur)) { $p = $procs | Where-Object { $_.ProcessId -eq $cur } | Select-Object -First 1; $cur = if ($p) { [int]$p.ParentProcessId } else { 0 } } }`,
      `$hits = @($procs | Where-Object { -not $exclude.Contains([int]$_.ProcessId) -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -ExpandProperty ProcessId)`,
      `Write-Output ($hits -join ',')`,
    ].join("\n");
    const out = execFileSync(
      psExe,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", syntheticCheck],
      {
        env: {
          ...process.env,
          DIMO_NSIS_INSTDIR: "C:\\Users\\O'Brien\\Dimo",
          DIMO_NSIS_SELF_PID: "101",
        },
        encoding: "utf8",
      },
    ).trim();
    assert.equal(
      out,
      "300",
      "must match only real app PID 300 inside O'Brien\\Dimo, excluding self (101), parent (100), and sibling prefix Dimo-dev (200)",
    );
  }
});

test("Windows NSIS interactive uninstall stops $DimoExistingDir, verifies exit code, and legacy Tauri cleanup handles unquoted UninstallString (E8)", () => {
  const installerNsi = fs.readFileSync(
    path.join(BUILD_DIR, "installer.nsi"),
    "utf8",
  );
  const pagesNsh = fs.readFileSync(
    path.join(BUILD_DIR, "installer", "pages.nsh"),
    "utf8",
  );
  const stringsNsh = fs.readFileSync(
    path.join(BUILD_DIR, "installer", "strings.nsh"),
    "utf8",
  );

  // Interactive uninstall branch inside Section "install"
  const uninstallStart = installerNsi.indexOf('${If} $DimoAction == "uninstall"');
  const uninstallEnd = installerNsi.indexOf("Goto dimo_install_done", uninstallStart);
  assert.ok(uninstallStart >= 0 && uninstallEnd > uninstallStart);
  const uninstallBlock = installerNsi.slice(uninstallStart, uninstallEnd);

  assert.match(uninstallBlock, /StrCpy\s+\$DimoCheckDir\s+"\$DimoExistingDir"/);
  assert.match(uninstallBlock, /Call\s+DimoCheckAppRunningInDir\b/);
  assert.doesNotMatch(
    uninstallBlock,
    /Call\s+DimoCheckAppRunning\b(?!InDir)/,
    "interactive uninstall must stop processes under $DimoExistingDir, not $INSTDIR",
  );
  assert.match(uninstallBlock, /ExecWait\s+'"\$R2"\s+\/S\s+_\?=\$DimoExistingDir'\s+\$0/);
  assert.match(
    uninstallBlock,
    /\$\{If\}\s+\$\{Errors\}\s*\r?\n\s*\$\{OrIf\}\s+\$0\s+!=\s+0[\s\S]*?DIMO_UNINSTALL_FAILED[\s\S]*?Call\s+DimoShowError[\s\S]*?Goto\s+dimo_uninstall_retry/,
    "interactive uninstall must check ExecWait errors/exit code and show retryable error instead of success page",
  );
  assert.match(stringsNsh, /!insertmacro\s+DIMO_STR\s+DIMO_UNINSTALL_FAILED\b/);
  assert.match(
    pagesNsh,
    /\$\{If\}\s+\$DimoAction\s+==\s+"uninstall"[\s\S]*?\$\(DIMO_UNINSTALL_FAILED\)/,
  );

  // Legacy Tauri cleanup must handle unquoted UninstallString via ${Else} when GetInQuotes is empty.
  const tauriStart = installerNsi.indexOf('ReadRegStr $R0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Dimo" "UninstallString"');
  const tauriEnd = installerNsi.indexOf('Delete "$R1\\uninstall.exe"', tauriStart);
  assert.ok(tauriStart >= 0 && tauriEnd > tauriStart);
  const tauriBlock = installerNsi.slice(tauriStart, tauriEnd);

  assert.match(tauriBlock, /!insertmacro\s+GetInQuotes\s+\$R2\s+"\$R0"/);
  assert.match(
    tauriBlock,
    /\$\{Else\}\s*\r?\n\s*\$\{If\}\s+\$R2\s+==\s+""[\s\S]*?ExecWait\s+'\$R0\s+\/S\s+\/UPDATE\s+_\?=\$R1'\s+\$0/,
    "legacy Tauri cleanup must fall back to raw $R0 when GetInQuotes returns empty for unquoted UninstallString",
  );
});
