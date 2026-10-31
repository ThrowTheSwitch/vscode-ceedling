import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { DISCOVERY_SETTINGS, SETTING_DEFAULTS, setting, type SettingKey } from '../../src/settings';

// Compiled tests run from out-test/tests/unit, three levels below the repository.
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default?: unknown, properties?: Record<string, { default?: unknown }> }> } },
};

// Each contributed setting by the key code reads it with: an object setting's fields by dotted key.
function contributedDefaults(): Map<string, unknown> {
    const defaults = new Map<string, unknown>();
    for (const [name, property] of Object.entries(packageJson.contributes.configuration.properties)) {
        const key = name.replace(/^ceedlingExplorer\./, '');
        if (property.properties === undefined) {
            defaults.set(key, property.default);
        } else {
            for (const [field, fieldProperty] of Object.entries(property.properties)) defaults.set(`${key}.${field}`, fieldProperty.default);
        }
    }
    return defaults;
}

suite('settings', () => {
    // VS Code falls back to package.json's default, and code to its own, so the two must agree.
    test("every setting's default is the one package.json contributes, and every contributed setting is read", () => {
        assert.deepStrictEqual(new Map(Object.entries(SETTING_DEFAULTS)), contributedDefaults());
    });

    test('a setting reads its key with its own default', () => {
        const asked: Array<[string, unknown]> = [];
        const source = { get: <T>(key: string, fallback: T): T => { asked.push([key, fallback]); return fallback; } };
        assert.deepStrictEqual(setting(source, 'testCommandArgs'), ['test:${TEST_ID}']);
        assert.deepStrictEqual(asked, [['testCommandArgs', ['test:${TEST_ID}']]]);
    });

    test('the settings that rediscover are settings', () => {
        const keys = Object.keys(SETTING_DEFAULTS) as SettingKey[];
        assert.ok(DISCOVERY_SETTINGS.every((key) => keys.includes(key)));
    });
});
