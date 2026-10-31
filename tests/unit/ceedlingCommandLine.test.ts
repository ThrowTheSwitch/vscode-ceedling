import * as assert from 'assert';
import path from 'path';
import { buildProjectArgs, taskArgs } from '../../src/ceedlingCommandLine';
import type { LoadedProject } from '../../src/ceedlingProjectConfig';
import { capabilitiesOf } from '../../src/ceedlingVersions';

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

suite('taskArgs', () => {
    const project = (release: string, files: string[]) => ({
        release, capabilities: capabilitiesOf(release), files: files.map((id) => ({ id })),
    }) as unknown as LoadedProject;
    const gcov = { reportTask: false, coberturaReports: ['x'] };

    test('a test file is named by its path where Ceedling takes one, else by its name, with any --test-case filter', () => {
        assert.deepStrictEqual(taskArgs(project('1.2.0', []), 'test/unit/test_a.c', undefined, ['test:${TEST_ID}'], 'test_x', path.posix),
            { args: ['test:test/unit/test_a.c', '--test-case=test_x'], warning: undefined });
        assert.deepStrictEqual(taskArgs(project('1.1.10', []), 'test/unit/test_a.c', undefined, ['test:${TEST_ID}'], undefined, path.posix).args, ['test:test_a.c']);
    });

    test('a deferred coverage report adds report:gcov once', () => {
        assert.deepStrictEqual(taskArgs(project('1.2.1', []), 'all', { ...gcov, reportTask: true }, ['gcov:${TEST_ID}'], undefined, path.posix).args, ['gcov:all', 'report:gcov']);
        assert.deepStrictEqual(taskArgs(project('1.2.1', []), 'all', { ...gcov, reportTask: true }, ['gcov:${TEST_ID}', 'report:gcov'], undefined, path.posix).args, ['gcov:all', 'report:gcov']);
    });

    // Before 1.2.1 a gcov: task takes a bare name, which a same-named file elsewhere shares.
    test('a coverage run that names a file its namesake shares warns', () => {
        const { warning } = taskArgs(project('1.2.0', ['test/a/test_x.c', 'test/b/test_x.c']), 'test/a/test_x.c', gcov, ['gcov:${TEST_ID}'], undefined, path.posix);
        assert.match(warning ?? '', /can't tell apart from 'test\/b\/test_x\.c'.*ambiguous file reference.*1\.2\.1/);
    });
});
