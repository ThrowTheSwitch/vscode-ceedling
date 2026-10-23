// Builds the --project/--mixin flags common to every Ceedling invocation for a project, in
// Ceedling's own priority order. A later --mixin flag outranks an earlier one, and a mixin's lists
// merge by prepending onto the existing list rather than replacing it. Lowest to highest
// priority: the project's alternate project file (ceedlingExplorer.projects[].path naming a yml
// other than project.yml), the user's configured mixins (already resolved into one ordered list),
// then the extension's own report-plugin mixin, always last so it always wins. Tokens are raw.
// CeedlingRunner quotes them when it builds the command line.
export function buildProjectArgs(ymlFileName: string, userMixins: readonly string[], bundledMixinPath: string): string[] {
    const args = ['--project', 'project.yml'];
    if (ymlFileName !== 'project.yml') {
        args.push('--mixin', ymlFileName);
    }
    for (const mixin of userMixins) {
        args.push('--mixin', mixin);
    }
    args.push('--mixin', bundledMixinPath);
    return args;
}
