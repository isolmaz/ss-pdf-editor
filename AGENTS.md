# Agent notes

## No LibreOffice

- Do not install, download, launch or call LibreOffice or any derivative (`soffice`, `soffice.bin`, OpenOffice, unoconv, portable copies) in this repository, its tests, scripts or subagent tasks, and do not create LibreOffice profile directories (`-env:UserInstallation`, `*lo-profile*`).
- Reason: headless LibreOffice runs hang on the owner's machine. The LibreOffice-based PDF → Word fidelity harness was removed for that reason.
- If a task needs office-format conversion or rendering, ask the owner which alternative to use instead of reinstalling LibreOffice.
- The notes in `docs/architecture.md` about how Word and LibreOffice lay out documents are recorded findings, not a dependency.
