# Workspace without a Ceedling project

The integration tests open this folder alongside the [fake Ceedling project](../workspace-fake-ceedling). It deliberately holds no `project.yml` or `ceedling.yml`. The extension must find no Ceedling project here, add nothing to the Testing view for it, and never run Ceedling in it.
