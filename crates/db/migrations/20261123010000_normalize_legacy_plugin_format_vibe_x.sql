-- Normalize legacy pre-rename `"vibe_x"` entries inside
-- `plugin_packages_v4.package_json` (`$.formats`) to `"dimo"` while
-- deduplicating if `"dimo"` is already present.
UPDATE plugin_packages_v4
SET package_json = json_set(
    package_json,
    '$.formats',
    json(
        COALESCE(
            (
                SELECT json_group_array(fmt)
                FROM (
                    SELECT CASE WHEN value = 'vibe_x' THEN 'dimo' ELSE value END AS fmt,
                           MIN(key) AS first_idx
                    FROM json_each(plugin_packages_v4.package_json, '$.formats')
                    GROUP BY CASE WHEN value = 'vibe_x' THEN 'dimo' ELSE value END
                    ORDER BY first_idx
                )
            ),
            '[]'
        )
    )
)
WHERE json_valid(package_json)
  AND json_type(package_json, '$.formats') = 'array'
  AND EXISTS (
      SELECT 1
      FROM json_each(plugin_packages_v4.package_json, '$.formats')
      WHERE value = 'vibe_x'
  );
