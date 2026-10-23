import * as assert from 'assert';
import { buildProjectArgs } from '../../src/ceedlingMixinArgs';

// Ceedling's own mixin rule: a later --mixin flag outranks an earlier one, and lists merge by
// prepending the higher-priority mixin's entries. That makes flag order the whole design here -
// see buildProjectArgs's own comment for the three-tier priority this pins down.

suite('buildProjectArgs', () => {
    test('a default project.yml with no user mixins gets --project and the bundled mixin only', () => {
        const args = buildProjectArgs('project.yml', [], '/ext/assets/mixins/report-tests-log-factory.yml');
        assert.deepStrictEqual(args, [
            '--project', 'project.yml',
            '--mixin', '/ext/assets/mixins/report-tests-log-factory.yml',
        ]);
    });

    test('an alternate/mixin project yml file name is placed lowest priority, right after --project', () => {
        const args = buildProjectArgs('ci.yml', [], '/ext/bundled.yml');
        assert.deepStrictEqual(args, [
            '--project', 'project.yml',
            '--mixin', 'ci.yml',
            '--mixin', '/ext/bundled.yml',
        ]);
    });

    test('user-configured mixins are placed between the alternate yml and the bundled mixin, in array order', () => {
        const args = buildProjectArgs('ci.yml', ['gcc', 'proj/mixins/coverage.yml'], '/ext/bundled.yml');
        assert.deepStrictEqual(args, [
            '--project', 'project.yml',
            '--mixin', 'ci.yml',
            '--mixin', 'gcc',
            '--mixin', 'proj/mixins/coverage.yml',
            '--mixin', '/ext/bundled.yml',
        ]);
    });

    test('the bundled mixin is always last, regardless of how many user mixins precede it', () => {
        const args = buildProjectArgs('project.yml', ['a', 'b', 'c'], '/ext/bundled.yml');
        assert.strictEqual(args[args.length - 2], '--mixin');
        assert.strictEqual(args[args.length - 1], '/ext/bundled.yml');
    });

    // Quoting happens once, when CeedlingRunner builds the command line (see ceedlingProcess.test.ts).
    test('a value containing whitespace is passed through unquoted', () => {
        const args = buildProjectArgs('project.yml', [], '/Program Files/ext/bundled.yml');
        assert.deepStrictEqual(args, ['--project', 'project.yml', '--mixin', '/Program Files/ext/bundled.yml']);
    });

    test('--project itself is never quoted - it is always the literal "project.yml"', () => {
        const args = buildProjectArgs('project.yml', [], '/ext/bundled.yml');
        assert.strictEqual(args[1], 'project.yml');
    });
});
