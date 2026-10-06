# Security policy

SsPdfEditor processes documents entirely in the browser: files are opened from the device,
edited in the tab and written back to the device, with no upload and no server-side
processing. A vulnerability here is anything that breaks that promise or the integrity of
the files it writes, for example:

- document content, metadata or passwords leaving the device;
- a crafted PDF that executes script or escapes the editor's content security policy;
- redaction that leaves the removed text recoverable in the saved file;
- a signature, encryption or permission result reported as valid when it is not.

## Reporting

Please **do not open a public issue** for a vulnerability. Email
**info@isolmaz.com** with a description, the steps to reproduce, and a sample file if one
is needed (strip anything confidential from it first). You will get an acknowledgement
within a few days, and a fix or a stated decision as soon as the issue is understood.

## Supported versions

Only the latest release, deployed at <https://pdf.isolmaz.com/editor/>, and the `main`
branch receive fixes.
