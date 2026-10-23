# Acknowledgments

This extension builds on the work of everyone below. The first section is the extension’s origin, as the README tells it. The second credits contributions made since.

## The original extension

This VS Code extension is a fork of the original _Ceedling Test Explorer_ extension [[Github][ceedling-test-explorer-github], [Marketplace][ceedling-test-explorer-marketplace]] authored by [Kin Numaru](https://github.com/numaru). It was taken over by the [ThrowTheSwitch](https://throwtheswitch.org) community, the authors and maintainers of Ceedling itself, with Kin’s blessing.

Ceedling 1.0.0 compatibility was added to the original extension by merging a [PR][1.0.0-pr] authored by [@simeon-s1](https://github.com/simeon-s1).

Thank you to Kin, @simeon-s1, and all those who contributed to the original repository.

[ceedling-test-explorer-github]: https://github.com/numaru/vscode-ceedling-test-adapter.git
[ceedling-test-explorer-marketplace]: https://marketplace.visualstudio.com/items?itemName=numaru.vscode-ceedling-test-adapter
[1.0.0-pr]: https://github.com/numaru/vscode-ceedling-test-adapter/pull/139

## Contributions to this extension

- **Code coverage.** [Jake Jooncheol Kim](https://github.com/jake-kim-sndk) designed and wrote native test coverage from Ceedling’s gcov plugin, in [PR #13][coverage-pr]. His work covered the _Run with Coverage_ profile, reading gcovr’s Cobertura report into VS Code’s coverage API, and the path handling that report needs. His pull request closed before it could merge. His commit was carried forward onto the reworked extension under his authorship, and his engine and controller changes were ported to the new code.

[coverage-pr]: https://github.com/ThrowTheSwitch/vscode-ceedling/pull/13
