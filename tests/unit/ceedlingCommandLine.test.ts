import * as assert from 'assert';
import { buildProjectArgs } from '../../src/ceedlingCommandLine';

// A later --mixin flag outranks an earlier one in Ceedling, so flag order is the whole design.
// These tests pin buildProjectArgs's priority order: alternate project file, user mixins, then
// the bundled mixin.

suite('buildProjectArgs', () => {
    test('a ceedling.yml project names it with --project', () => {
        assert.deepStrictEqual(buildProjectArgs('ceedling.yml', 'ceedling.yml', [], '/ext/bundled.yml'),
            ['--project', 'ceedling.yml', '--mixin', '/ext/bundled.yml']);
    });

    test('an alternate project file applies as a mixin over a ceedling.yml base', () => {
        assert.deepStrictEqual(buildProjectArgs('ceedling.yml', 'ci.yml', [], '/ext/bundled.yml'),
            ['--project', 'ceedling.yml', '--mixin', 'ci.yml', '--mixin', '/ext/bundled.yml']);
    });

    test('a default project.yml with no user mixins gets --project and the bundled mixin only', () => {
        const args = buildProjectArgs('project.yml', 'project.yml', [], '/ext/assets/mixins/report-tests-log-factory.yml');
        assert.deepStrictEqual(args, [
            '--project', 'project.yml',
            '--mixin', '/ext/assets/mixins/report-tests-log-factory.yml',
        ]);
    });

    test('an alternate/mixin project yml file name is placed lowest priority, right after --project', () => {
        const args = buildProjectArgs('project.yml', 'ci.yml', [], '/ext/bundled.yml');
        assert.deepStrictEqual(args, [
            '--project', 'project.yml',
            '--mixin', 'ci.yml',
            '--mixin', '/ext/bundled.yml',
        ]);
    });

    test('user-configured mixins are placed between the alternate yml and the bundled mixin, in array order', () => {
        const args = buildProjectArgs('project.yml', 'ci.yml', ['gcc', 'proj/mixins/coverage.yml'], '/ext/bundled.yml');
        assert.deepStrictEqual(args, [
            '--project', 'project.yml',
            '--mixin', 'ci.yml',
            '--mixin', 'gcc',
            '--mixin', 'proj/mixins/coverage.yml',
            '--mixin', '/ext/bundled.yml',
        ]);
    });

    test('the bundled mixin is always last, regardless of how many user mixins precede it', () => {
        const args = buildProjectArgs('project.yml', 'project.yml', ['a', 'b', 'c'], '/ext/bundled.yml');
        assert.strictEqual(args[args.length - 2], '--mixin');
        assert.strictEqual(args[args.length - 1], '/ext/bundled.yml');
    });

    // Quoting happens once, when CeedlingRunner builds the command line (see ceedlingProcess.test.ts).
    test('a value containing whitespace is passed through unquoted', () => {
        const args = buildProjectArgs('project.yml', 'project.yml', [], '/Program Files/ext/bundled.yml');
        assert.deepStrictEqual(args, ['--project', 'project.yml', '--mixin', '/Program Files/ext/bundled.yml']);
    });

    test('a default project.yml is passed to --project', () => {
        const args = buildProjectArgs('project.yml', 'project.yml', [], '/ext/bundled.yml');
        assert.strictEqual(args[1], 'project.yml');
    });
});
