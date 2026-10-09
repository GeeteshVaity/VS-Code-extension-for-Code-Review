# CoT Deep Code Review: Usage Guide

## Readiness

The extension is ready for local use and VSIX installation.

Verified in this repository:

- TypeScript type checks pass.
- The production extension bundle builds successfully.
- All 23 automated tests pass.
- A VSIX package is generated successfully.

The extension requires VS Code `1.140.0` or newer and an internet connection to
call the Groq API using the `openai/gpt-oss-120b` model. It reviews only the
code selected in the active editor.

## Install and run from source

1. Install Node.js and VS Code.
2. Open this repository in VS Code.
3. Install dependencies:

   ```bash
   npm install
   ```

4. Start the extension development host:
   - Press `F5`, or
   - Open **Run and Debug** and choose **Run Extension**.
5. In the new **Extension Development Host** window, open a source file.

## Install from a VSIX package

Build the installable package:

```bash
npm install
npm run package
```

In VS Code, open **Extensions**, select the **...** menu, choose **Install from
VSIX...**, and select `cot-deep-review-0.1.0.vsix` from the repository folder.

## Configure the Groq API key

Create a developer key at <https://console.groq.com/keys>.

You can provide it either way:

- Run the review once and enter the key when prompted. The extension stores it
  in the machine-scoped `cotReviewer.groqApiKey` setting.
- Open **Settings**, search for `CoT Deep Code Review`, and set
  `cotReviewer.groqApiKey`.

Do not commit the API key or put it in source code.

## Run a review

1. Open the file containing the code to review.
2. Highlight a non-empty code block.
3. Right-click the selection and choose **CoT: Run Deep Code Review**.
   Alternatively, open the Command Palette (`Ctrl+Shift+P`) and run the same
   command.
4. Wait for the **CoT Deep Review** panel to finish loading.
5. Inspect the four sections:
   - **Execution Trace**: async task and microtask ordering.
   - **Vulnerability Analysis**: race conditions, rejection problems, and
     lifecycle or memory issues.
   - **Impact Assessment**: failure scenarios and architectural impact.
   - **Refactored Code**: the proposed replacement for the selected region.
6. Select **Replace in Editor** only after reviewing the proposed changes.

The panel checks whether the original selection changed while the review was
running. If it changed, VS Code asks for confirmation before replacing it.

## Development commands

```bash
npm run typecheck  # TypeScript and fixture checks
npm test           # Bundle and run all automated tests
npm run build      # Build dist/extension.js
npm run watch      # Rebuild while source files change
npm run package    # Create a .vsix package
```

## Troubleshooting

- **No review starts:** make sure a file is open and code is selected.
- **API key prompt keeps returning:** verify the key is valid and that VS Code
  can write machine-scoped settings.
- **Authentication or rate-limit error:** check the Groq key, account limits,
  and the error message shown in the review panel.
- **The replacement is rejected:** the selected text changed after analysis;
  run the review again against the current code.
- **The panel reports invalid model output:** retry the review. The extension
  validates the response schema before showing a result.
