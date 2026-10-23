// Reading XML as xml2js parses it with `explicitArray: false`, where every value is untyped. That
// option yields a bare object for a container holding one child, and an empty string for an empty
// self-closing container. `list` makes both a list.

// The value at `key` when `value` is an object, else undefined.
export function field(value: unknown, key: string): unknown {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
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
