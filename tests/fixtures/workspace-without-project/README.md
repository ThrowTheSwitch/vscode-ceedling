# Workspace without a Ceedling project

The integration tests open this folder as their workspace. It deliberately holds no `project.yml` or `ceedling.yml`, so the extension activates, finds no Ceedling project, and never runs Ceedling. That keeps the integration tests independent of a Ceedling installation.
