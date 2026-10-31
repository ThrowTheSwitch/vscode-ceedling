// Reading parsed data whose every value is untyped: XML as xml2js parses it with
// `explicitArray: false`, and YAML as js-yaml loads it. That option yields a bare object for a
// container holding one child, and an empty string for an empty self-closing container. `list`
// makes both a list.
import xml2js from 'xml2js';

// Every reader here expects `explicitArray: false`.
export function parseXml(xml: string): Promise<unknown> {
    return new xml2js.Parser({ explicitArray: false }).parseStringPromise(xml) as Promise<unknown>;
}

// The value at a path of keys, or undefined anywhere along a missing path.
export function field(value: unknown, ...keys: string[]): unknown {
    let found = value;
    for (const key of keys) {
        if (typeof found !== 'object' || found === null) {
            return undefined;
        }
        found = (found as Record<string, unknown>)[key];
    }
    return found;
}

// The text of a value, or '' when it isn't text.
export function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

export function list(value: unknown): unknown[] {
    if (value === undefined || value === null || value === '') {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}
