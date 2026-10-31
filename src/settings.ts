// The extension's settings, each with the default package.json contributes for it. Every read goes
// through setting(), so code can't fall back to a default of its own, and a unit test holds this
// table to package.json. It has no `vscode` dependency: a WorkspaceConfiguration is a SettingsSource.
import type { ProjectSetting } from './ceedlingProjectConfig';

// Each setting under `ceedlingExplorer.`, by the key VS Code reads it with. package.json gives
// problemMatching as one object, whose fields are read by dotted key.
export type Settings = {
    projects: readonly ProjectSetting[],
    mixins: readonly string[],
    shellPath: string | null,
    ceedlingCommand: string,
    prettyTestLabel: boolean,
    prettyTestFileLabel: boolean,
    testCommandArgs: readonly string[],
    coverageCommandArgs: readonly string[],
    coverageResetsCounters: boolean,
    'problemMatching.mode': string,
    // Untyped user JSON. matchProblems() validates each pattern.
    'problemMatching.patterns': readonly unknown[],
    ansiEscapeSequencesRemoved: boolean,
};

export type SettingKey = keyof Settings;

export const SETTING_DEFAULTS: { readonly [K in SettingKey]: Settings[K] } = {
    projects: [],
    mixins: [],
    shellPath: null,
    ceedlingCommand: 'ceedling',
    prettyTestLabel: true,
    prettyTestFileLabel: true,
    testCommandArgs: ['test:${TEST_ID}'],
    coverageCommandArgs: ['gcov:${TEST_ID}'],
    coverageResetsCounters: true,
    'problemMatching.mode': 'disabled',
    'problemMatching.patterns': [],
    ansiEscapeSequencesRemoved: true,
};

// Settings whose change changes what discovery finds, including how it reads Ceedling's output.
// The rest apply on the next run.
export const DISCOVERY_SETTINGS: readonly SettingKey[] = [
    'projects', 'mixins', 'shellPath', 'ceedlingCommand', 'prettyTestLabel', 'prettyTestFileLabel', 'ansiEscapeSequencesRemoved',
];

// What settings are read from: a vscode.WorkspaceConfiguration, or a test's stand-in.
export type SettingsSource = { get<T>(section: string, defaultValue: T): T };

export function setting<K extends SettingKey>(source: SettingsSource, key: K): Settings[K] {
    return source.get<Settings[K]>(key, SETTING_DEFAULTS[key]);
}
