# Third-party notices

Sedes is distributed under the MIT License; see [LICENSE](LICENSE) for its terms.
The repository contains Sedes source only and commits no third-party code.
Building or installing Sedes pulls its dependencies from npm, and a built
installation or packaged artifact then contains them. This file lists that
production dependency closure with each package's license identifier and,
where the package ships one, its full license text, so that anyone who
distributes a built artifact can meet the attribution and license-retention
terms of the packages inside it.

The closure covers the root package, the workspaces under `packages/`, and
`electron/`, and excludes devDependencies. `package-lock.json` is the source
of truth for what is installed, and a root that owns a `package-lock.json` is
walked through that workspace lockfile because packaging installs it from
there; `dependencies`, installed `optionalDependencies`, and required
`peerDependencies` are followed transitively through nested `node_modules`.
Each entry names the roots that ship it, so a package pinned at two versions
is listed once per version. Packages recorded in the lockfile
but absent from an installed tree (for example the platform-specific Claude
Code executable packages, which the `postinstall` step removes) are not part
of a built installation and are not listed.

This file is generated. Run `npm run generate:third-party-notices` to refresh it
and `npm run check:third-party-notices` to verify that it is current.

Packages listed: 595.

## Packages

### @agentclientprotocol/sdk 1.3.0

- License: Apache-2.0
- URL: https://github.com/agentclientprotocol/typescript-sdk
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [e8e2fe35f5fd](#license-text-e8e2fe35f5fd)

### @antfu/install-pkg 1.1.0

- License: MIT
- URL: https://github.com/antfu/install-pkg
- Shipped by: sedes
- License text (`LICENSE`): [665f7d320f28](#license-text-665f7d320f28)

### @anthropic-ai/claude-agent-sdk 0.3.274

- License: SEE LICENSE IN README.md
- URL: https://github.com/anthropics/claude-agent-sdk-typescript
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.md`): [af2be7b670a0](#license-text-af2be7b670a0)

### @anthropic-ai/sdk 0.124.0

- License: MIT
- URL: https://github.com/anthropics/anthropic-sdk-typescript
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d298496454d4](#license-text-d298496454d4)

### @aws-sdk/client-bedrock-runtime 3.1127.0

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/clients/client-bedrock-runtime
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [711cb7cff0da](#license-text-711cb7cff0da)

### @aws-sdk/core 3.977.9

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/core
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [edea91454b81](#license-text-edea91454b81)

### @aws-sdk/core 3.978.0

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/core
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [edea91454b81](#license-text-edea91454b81)

### @aws-sdk/credential-provider-env 3.972.70

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-env
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @aws-sdk/credential-provider-env 3.972.71

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-env
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @aws-sdk/credential-provider-http 3.972.72

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-http
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @aws-sdk/credential-provider-http 3.972.73

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-http
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @aws-sdk/credential-provider-ini 3.973.15

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-ini
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @aws-sdk/credential-provider-ini 3.973.16

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-ini
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @aws-sdk/credential-provider-login 3.972.77

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-login
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @aws-sdk/credential-provider-login 3.972.78

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-login
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @aws-sdk/credential-provider-node 3.972.82

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-node
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @aws-sdk/credential-provider-node 3.972.83

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-node
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @aws-sdk/credential-provider-process 3.972.70

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-process
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [2ef1e48ea743](#license-text-2ef1e48ea743)

### @aws-sdk/credential-provider-process 3.972.71

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-process
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [2ef1e48ea743](#license-text-2ef1e48ea743)

### @aws-sdk/credential-provider-sso 3.973.14

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-sso
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [2ef1e48ea743](#license-text-2ef1e48ea743)

### @aws-sdk/credential-provider-sso 3.973.15

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-sso
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [2ef1e48ea743](#license-text-2ef1e48ea743)

### @aws-sdk/credential-provider-web-identity 3.972.76

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-web-identity
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [2ef1e48ea743](#license-text-2ef1e48ea743)

### @aws-sdk/credential-provider-web-identity 3.972.77

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/credential-provider-web-identity
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [2ef1e48ea743](#license-text-2ef1e48ea743)

### @aws-sdk/eventstream-handler-node 3.972.34

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/eventstream-handler-node
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [2ef1e48ea743](#license-text-2ef1e48ea743)

### @aws-sdk/middleware-eventstream 3.972.29

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/middleware-eventstream
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @aws-sdk/middleware-websocket 3.972.52

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/middleware-websocket
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [2ef1e48ea743](#license-text-2ef1e48ea743)

### @aws-sdk/middleware-websocket 3.972.53

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/middleware-websocket
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [2ef1e48ea743](#license-text-2ef1e48ea743)

### @aws-sdk/nested-clients 3.997.44

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages/nested-clients
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @aws-sdk/nested-clients 3.997.45

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages/nested-clients
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @aws-sdk/signature-v4-multi-region 3.996.46

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages/signature-v4-multi-region
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [2ef1e48ea743](#license-text-2ef1e48ea743)

### @aws-sdk/token-providers 3.1116.0

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages/token-providers
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @aws-sdk/token-providers 3.1127.0

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages/token-providers
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @aws-sdk/token-providers 3.1129.0

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages/token-providers
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @aws-sdk/types 3.974.5

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/types
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @aws-sdk/xml-builder 3.972.40

- License: Apache-2.0
- URL: https://github.com/aws/aws-sdk-js-v3/tree/HEAD/packages-internal/xml-builder
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @aws/lambda-invoke-store 0.3.0

- License: Apache-2.0
- URL: https://github.com/awslabs/aws-lambda-invoke-store
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [7fb46adff902](#license-text-7fb46adff902)

### @babel/runtime 7.29.2

- License: MIT
- URL: https://github.com/babel/babel/tree/HEAD/packages/babel-runtime
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [8f08c824b2bb](#license-text-8f08c824b2bb)

### @babel/runtime 7.29.7

- License: MIT
- URL: https://github.com/babel/babel/tree/HEAD/packages/babel-runtime
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [8f08c824b2bb](#license-text-8f08c824b2bb)

### @braintree/sanitize-url 7.1.2

- License: MIT
- URL: https://github.com/braintree/sanitize-url
- Shipped by: sedes
- License text (`LICENSE`): [0bc46fcdad09](#license-text-0bc46fcdad09)

### @capacitor/app 8.1.0

- License: MIT
- URL: https://github.com/ionic-team/capacitor-plugins
- Shipped by: sedes
- License text (`LICENSE`): [eb99a0d61b50](#license-text-eb99a0d61b50)

### @capacitor/core 8.4.0

- License: MIT
- URL: https://github.com/ionic-team/capacitor
- Shipped by: sedes
- License text (`LICENSE`): [7edf453d1584](#license-text-7edf453d1584)

### @capacitor/keyboard 8.0.5

- License: MIT
- URL: https://github.com/ionic-team/capacitor-keyboard
- Shipped by: sedes
- License text (`LICENSE`): [eb99a0d61b50](#license-text-eb99a0d61b50)

### @capacitor/preferences 8.0.1

- License: MIT
- URL: https://github.com/ionic-team/capacitor-plugins
- Shipped by: sedes
- License text (`LICENSE`): [eb99a0d61b50](#license-text-eb99a0d61b50)

### @capawesome/capacitor-electron 0.1.0

- License: MIT
- URL: https://github.com/capawesome-team/capacitor-electron
- Shipped by: sedes
- License text (`LICENSE`): [8fc1d534e3ef](#license-text-8fc1d534e3ef)

### @chevrotain/types 11.1.2

- License: Apache-2.0
- URL: https://github.com/Chevrotain/chevrotain
- Shipped by: sedes
- License text (`LICENSE.txt`): [283ea6cc2997](#license-text-283ea6cc2997)

### @earendil-works/chord 0.86.0

- License: MIT
- URL: https://github.com/earendil-works/pi/tree/HEAD/packages/chord
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @earendil-works/pi-agent-core 0.86.0

- License: MIT
- URL: https://github.com/earendil-works/pi/tree/HEAD/packages/agent
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @earendil-works/pi-ai 0.86.0

- License: MIT
- URL: https://github.com/earendil-works/pi/tree/HEAD/packages/ai
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @earendil-works/pi-coding-agent 0.86.0

- License: MIT
- URL: https://github.com/earendil-works/pi/tree/HEAD/packages/coding-agent
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @earendil-works/pi-telemetry 0.86.0

- License: MIT
- URL: https://github.com/earendil-works/pi/tree/HEAD/packages/telemetry
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @earendil-works/pi-tui 0.86.0

- License: MIT
- URL: https://github.com/earendil-works/pi/tree/HEAD/packages/tui
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/aix-ppc64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/android-arm 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/android-arm64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/android-x64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/darwin-arm64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/darwin-x64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/freebsd-arm64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/freebsd-x64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/linux-arm 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/linux-arm64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/linux-ia32 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/linux-loong64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/linux-mips64el 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/linux-ppc64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/linux-riscv64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/linux-s390x 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/linux-x64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/netbsd-arm64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/netbsd-x64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/openbsd-arm64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/openbsd-x64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/openharmony-arm64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/sunos-x64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/win32-arm64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/win32-ia32 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @esbuild/win32-x64 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @floating-ui/core 1.8.0

- License: MIT
- URL: https://github.com/floating-ui/floating-ui/tree/HEAD/packages/core
- Shipped by: sedes
- License text (`LICENSE`): [6c1117dc530c](#license-text-6c1117dc530c)

### @floating-ui/dom 1.8.0

- License: MIT
- URL: https://github.com/floating-ui/floating-ui/tree/HEAD/packages/dom
- Shipped by: sedes
- License text (`LICENSE`): [6c1117dc530c](#license-text-6c1117dc530c)

### @floating-ui/react-dom 2.1.9

- License: MIT
- URL: https://github.com/floating-ui/floating-ui/tree/HEAD/packages/react-dom
- Shipped by: sedes
- License text (`LICENSE`): [6c1117dc530c](#license-text-6c1117dc530c)

### @floating-ui/utils 0.2.12

- License: MIT
- URL: https://github.com/floating-ui/floating-ui/tree/HEAD/packages/utils
- Shipped by: sedes
- License text (`LICENSE`): [6c1117dc530c](#license-text-6c1117dc530c)

### @fontsource-variable/inter 5.3.0

- License: OFL-1.1
- URL: https://github.com/fontsource/font-files/tree/HEAD/fonts/variable/inter
- Shipped by: sedes
- License text (`LICENSE`): [bfe1e5d7dd50](#license-text-bfe1e5d7dd50)

### @google/genai 2.21.0

- License: Apache-2.0
- URL: https://github.com/googleapis/js-genai
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [283ea6cc2997](#license-text-283ea6cc2997)

### @hono/node-server 2.0.12

- License: MIT
- URL: https://github.com/honojs/node-server
- Shipped by: sedes
- License text (`LICENSE`): [35d16fc259cf](#license-text-35d16fc259cf)

### @hono/node-server 2.1.1

- License: MIT
- URL: not declared in package metadata
- Shipped by: @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @iconify/types 2.0.0

- License: MIT
- URL: https://github.com/iconify/iconify/tree/HEAD/packages/types
- Shipped by: sedes
- License text (`license.txt`): [045ce74712fc](#license-text-045ce74712fc)

### @iconify/utils 3.1.4

- License: MIT
- URL: https://github.com/iconify/iconify/tree/HEAD/packages/utils
- Shipped by: sedes
- License text (`license.txt`): [a86793ac0231](#license-text-a86793ac0231)

### @mermaid-js/parser 1.2.0

- License: MIT
- URL: https://github.com/mermaid-js/mermaid/tree/HEAD/packages/parser
- Shipped by: sedes
- License text (`LICENSE`): [d872b89e34b7](#license-text-d872b89e34b7)

### @modelcontextprotocol/sdk 1.30.0

- License: MIT
- URL: https://github.com/modelcontextprotocol/typescript-sdk
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [8694aa57bec3](#license-text-8694aa57bec3)

### @noble/hashes 2.4.0

- License: MIT
- URL: https://github.com/paulmillr/noble-hashes
- Shipped by: sedes
- License text (`LICENSE`): [4f221aee6e07](#license-text-4f221aee6e07)

### @pierre/diffs 1.3.4

- License: apache-2.0
- URL: not declared in package metadata
- Shipped by: sedes
- License text (`LICENSE.md`): [2f09b31fcc47](#license-text-2f09b31fcc47)

### @pierre/theme 2.0.0

- License: apache-2.0
- URL: https://github.com/pierrecomputer/pierre/tree/HEAD/packages/theme
- Shipped by: sedes
- License text (`LICENSE`): [2f09b31fcc47](#license-text-2f09b31fcc47)

### @pierre/theming 1.0.0

- License: apache-2.0
- URL: not declared in package metadata
- Shipped by: sedes
- License text (`LICENSE.md`): [2f09b31fcc47](#license-text-2f09b31fcc47)

### @pierre/theming 1.0.1

- License: apache-2.0
- URL: not declared in package metadata
- Shipped by: sedes
- License text (`LICENSE.md`): [2f09b31fcc47](#license-text-2f09b31fcc47)

### @pierre/trees 1.0.0-beta.6

- License: apache-2.0
- URL: not declared in package metadata
- Shipped by: sedes
- License text (`LICENSE.md`): [2f09b31fcc47](#license-text-2f09b31fcc47)

### @protobufjs/aspromise 1.1.2

- License: BSD-3-Clause
- URL: https://github.com/dcodeIO/protobuf.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [56c9299ed8fb](#license-text-56c9299ed8fb)

### @protobufjs/base64 1.1.2

- License: BSD-3-Clause
- URL: https://github.com/dcodeIO/protobuf.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [56c9299ed8fb](#license-text-56c9299ed8fb)

### @protobufjs/codegen 2.0.5

- License: BSD-3-Clause
- URL: https://github.com/dcodeIO/protobuf.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [56c9299ed8fb](#license-text-56c9299ed8fb)

### @protobufjs/eventemitter 1.1.1

- License: BSD-3-Clause
- URL: https://github.com/dcodeIO/protobuf.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [56c9299ed8fb](#license-text-56c9299ed8fb)

### @protobufjs/fetch 1.1.1

- License: BSD-3-Clause
- URL: https://github.com/dcodeIO/protobuf.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [56c9299ed8fb](#license-text-56c9299ed8fb)

### @protobufjs/float 1.0.2

- License: BSD-3-Clause
- URL: https://github.com/dcodeIO/protobuf.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [56c9299ed8fb](#license-text-56c9299ed8fb)

### @protobufjs/path 1.1.2

- License: BSD-3-Clause
- URL: https://github.com/dcodeIO/protobuf.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [56c9299ed8fb](#license-text-56c9299ed8fb)

### @protobufjs/pool 1.1.0

- License: BSD-3-Clause
- URL: https://github.com/dcodeIO/protobuf.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [56c9299ed8fb](#license-text-56c9299ed8fb)

### @protobufjs/utf8 1.1.1

- License: BSD-3-Clause
- URL: https://github.com/dcodeIO/protobuf.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [56c9299ed8fb](#license-text-56c9299ed8fb)

### @protobufjs/utf8 1.1.2

- License: BSD-3-Clause
- URL: https://github.com/protobufjs/protobuf.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [56c9299ed8fb](#license-text-56c9299ed8fb)

### @radix-ui/number 1.1.3

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/core/number
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/primitive 1.1.7

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/core/primitive
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-accessible-icon 1.1.15

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/accessible-icon
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-accordion 1.2.20

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/accordion
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-alert-dialog 1.1.23

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/alert-dialog
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-arrow 1.1.15

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/arrow
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-aspect-ratio 1.1.15

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/aspect-ratio
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-avatar 1.2.6

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/avatar
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-checkbox 1.3.11

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/checkbox
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-collapsible 1.1.20

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/collapsible
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-collection 1.1.15

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/collection
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-compose-refs 1.1.5

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/compose-refs
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-context 1.2.2

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/context
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-context-menu 2.3.7

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/context-menu
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-dialog 1.1.23

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/dialog
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-direction 1.1.4

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/direction
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-dismissable-layer 1.1.19

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/dismissable-layer
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-dropdown-menu 2.1.24

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/dropdown-menu
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-focus-guards 1.1.6

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/focus-guards
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-focus-scope 1.1.16

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/focus-scope
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-form 0.1.16

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/form
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-hover-card 1.1.23

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/hover-card
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-id 1.1.4

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/id
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-label 2.1.15

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/label
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-menu 2.1.24

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/menu
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-menubar 1.1.24

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/menubar
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-navigation-menu 1.2.22

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/navigation-menu
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-one-time-password-field 0.1.16

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/one-time-password-field
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-password-toggle-field 0.1.11

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/password-toggle-field
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-popover 1.1.23

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/popover
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-popper 1.3.7

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/popper
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-portal 1.1.17

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/portal
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-presence 1.1.10

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/presence
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-primitive 2.1.10

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/primitive
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-progress 1.1.16

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/progress
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-radio-group 1.4.7

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/radio-group
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-roving-focus 1.1.19

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/roving-focus
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-scroll-area 1.2.18

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/scroll-area
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-select 2.3.7

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/select
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-separator 1.1.15

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/separator
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-slider 1.4.7

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/slider
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-slot 1.3.3

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/slot
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-switch 1.3.7

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/switch
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-tabs 1.1.21

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/tabs
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-toast 1.2.23

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/toast
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-toggle 1.1.18

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/toggle
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-toggle-group 1.1.19

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/toggle-group
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-toolbar 1.1.19

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/toolbar
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-tooltip 1.2.16

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/tooltip
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-use-callback-ref 1.1.4

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/use-callback-ref
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-use-controllable-state 1.2.6

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/use-controllable-state
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-use-effect-event 0.0.5

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/use-effect-event
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-use-escape-keydown 1.1.5

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/use-escape-keydown
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-use-is-hydrated 0.1.3

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/use-is-hydrated
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-use-layout-effect 1.1.4

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/use-layout-effect
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-use-previous 1.1.4

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/use-previous
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-use-rect 1.1.4

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/use-rect
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-use-size 1.1.4

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/use-size
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/react-visually-hidden 1.2.11

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/visually-hidden
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @radix-ui/rect 1.1.3

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/core/rect
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### @shikijs/core 4.4.2

- License: MIT
- URL: https://github.com/shikijs/shiki/tree/HEAD/packages/core
- Shipped by: sedes
- License text (`LICENSE`): [f20e2ee5da6c](#license-text-f20e2ee5da6c)

### @shikijs/engine-javascript 4.4.2

- License: MIT
- URL: https://github.com/shikijs/shiki/tree/HEAD/packages/engine-javascript
- Shipped by: sedes
- License text (`LICENSE`): [f20e2ee5da6c](#license-text-f20e2ee5da6c)

### @shikijs/engine-oniguruma 4.4.2

- License: MIT
- URL: https://github.com/shikijs/shiki/tree/HEAD/packages/engine-oniguruma
- Shipped by: sedes
- License text (`LICENSE`): [f20e2ee5da6c](#license-text-f20e2ee5da6c)

### @shikijs/langs 4.4.2

- License: MIT
- URL: https://github.com/shikijs/shiki/tree/HEAD/packages/langs
- Shipped by: sedes
- License text (`LICENSE`): [f20e2ee5da6c](#license-text-f20e2ee5da6c)

### @shikijs/primitive 4.4.2

- License: MIT
- URL: https://github.com/shikijs/shiki/tree/HEAD/packages/primitive
- Shipped by: sedes
- License text (`LICENSE`): [f20e2ee5da6c](#license-text-f20e2ee5da6c)

### @shikijs/themes 4.4.2

- License: MIT
- URL: https://github.com/shikijs/shiki/tree/HEAD/packages/themes
- Shipped by: sedes
- License text (`LICENSE`): [f20e2ee5da6c](#license-text-f20e2ee5da6c)

### @shikijs/transformers 4.4.2

- License: MIT
- URL: https://github.com/shikijs/shiki/tree/HEAD/packages/transformers
- Shipped by: sedes
- License text (`LICENSE`): [f20e2ee5da6c](#license-text-f20e2ee5da6c)

### @shikijs/types 4.4.2

- License: MIT
- URL: https://github.com/shikijs/shiki/tree/HEAD/packages/types
- Shipped by: sedes
- License text (`LICENSE`): [f20e2ee5da6c](#license-text-f20e2ee5da6c)

### @shikijs/vscode-textmate 10.0.2

- License: MIT
- URL: https://github.com/shikijs/vscode-textmate
- Shipped by: sedes
- License text (`LICENSE.md`): [b09ac0e46520](#license-text-b09ac0e46520)

### @silvia-odwyer/photon-node 0.3.4

- License: Apache-2.0
- URL: https://github.com/silvia-odwyer/photon
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.md`): [bef9ee0b92a1](#license-text-bef9ee0b92a1)

### @smithy/core 3.33.3

- License: Apache-2.0
- URL: https://github.com/smithy-lang/smithy-typescript/tree/HEAD/packages/core
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [2ef1e48ea743](#license-text-2ef1e48ea743)

### @smithy/core 3.34.1

- License: Apache-2.0
- URL: https://github.com/smithy-lang/smithy-typescript/tree/HEAD/packages/core
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [2ef1e48ea743](#license-text-2ef1e48ea743)

### @smithy/credential-provider-imds 4.5.2

- License: Apache-2.0
- URL: https://github.com/smithy-lang/smithy-typescript/tree/HEAD/packages/credential-provider-imds
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @smithy/fetch-http-handler 5.8.0

- License: Apache-2.0
- URL: https://github.com/smithy-lang/smithy-typescript/tree/HEAD/packages/fetch-http-handler
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @smithy/node-http-handler 4.12.1

- License: Apache-2.0
- URL: https://github.com/smithy-lang/smithy-typescript/tree/HEAD/packages/node-http-handler
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @smithy/signature-v4 5.7.3

- License: Apache-2.0
- URL: https://github.com/smithy-lang/smithy-typescript/tree/HEAD/packages/signature-v4
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d82ceb8cbd00](#license-text-d82ceb8cbd00)

### @smithy/types 4.18.0

- License: Apache-2.0
- URL: https://github.com/smithy-lang/smithy-typescript/tree/HEAD/packages/types
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [2ef1e48ea743](#license-text-2ef1e48ea743)

### @stablelib/base64 1.0.1

- License: MIT
- URL: https://github.com/StableLib/stablelib
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [fe1812441c6d](#license-text-fe1812441c6d)

### @types/d3 7.4.3

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-array 3.2.2

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-array
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-axis 3.0.6

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-axis
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-brush 3.0.6

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-brush
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-chord 3.0.6

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-chord
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-color 3.1.3

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-color
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-contour 3.0.6

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-contour
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-delaunay 6.0.4

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-delaunay
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-dispatch 3.0.7

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-dispatch
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-drag 3.0.7

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-drag
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-dsv 3.0.7

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-dsv
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-ease 3.0.2

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-ease
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-fetch 3.0.7

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-fetch
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-force 3.0.10

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-force
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-format 3.0.4

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-format
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-geo 3.1.1

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-geo
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-hierarchy 3.1.7

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-hierarchy
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-interpolate 3.0.4

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-interpolate
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-path 3.1.1

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-path
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-polygon 3.0.2

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-polygon
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-quadtree 3.0.6

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-quadtree
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-random 3.0.4

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-random
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-scale 4.0.9

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-scale
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-scale-chromatic 3.1.0

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-scale-chromatic
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-selection 3.0.11

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-selection
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-shape 3.1.8

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-shape
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-time 3.0.4

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-time
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-time-format 4.0.3

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-time-format
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-timer 3.0.2

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-timer
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-transition 3.0.9

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-transition
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/d3-zoom 3.0.8

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/d3-zoom
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/debug 4.1.13

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/debug
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/estree 1.0.9

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/estree
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/estree-jsx 1.0.5

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/estree-jsx
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/geojson 7946.0.16

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/geojson
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/hast 3.0.5

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/hast
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/mdast 4.0.4

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/mdast
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/ms 2.1.0

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/ms
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/node 22.19.19

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/node
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/node 26.1.2

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/node
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/node 26.6.2

- License: MIT
- URL: not declared in package metadata
- Shipped by: @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @types/react 19.2.17

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/react
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/retry 0.12.0

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [8e1c6bd583a7](#license-text-8e1c6bd583a7)

### @types/trusted-types 2.0.7

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/trusted-types
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/unist 2.0.11

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/unist
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @types/unist 3.0.3

- License: MIT
- URL: https://github.com/DefinitelyTyped/DefinitelyTyped/tree/HEAD/types/unist
- Shipped by: sedes
- License text (`LICENSE`): [ff82c90f8494](#license-text-ff82c90f8494)

### @ungap/structured-clone 1.3.3

- License: ISC
- URL: https://github.com/ungap/structured-clone
- Shipped by: sedes
- License text (`LICENSE`): [22fc2b0e60ba](#license-text-22fc2b0e60ba)

### @upsetjs/venn.js 2.0.0

- License: MIT
- URL: https://github.com/upsetjs/venn.js
- Shipped by: sedes
- License text (`LICENSE`): [7bdac5ba137b](#license-text-7bdac5ba137b)

### @xterm/addon-serialize 0.14.0

- License: MIT
- URL: https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### @xterm/addon-unicode11 0.9.0

- License: MIT
- URL: https://github.com/xtermjs/xterm.js/tree/master/addons/addon-unicode11
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [c434897a5a6c](#license-text-c434897a5a6c)

### @xterm/headless 6.0.0

- License: MIT
- URL: https://github.com/xtermjs/xterm.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### accepts 2.0.0

- License: MIT
- URL: https://github.com/jshttp/accepts
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [a3fb4c94aaf6](#license-text-a3fb4c94aaf6)

### agent-base 7.1.4

- License: MIT
- URL: https://github.com/TooTallNate/proxy-agents/tree/HEAD/packages/agent-base
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [8d8c55319c77](#license-text-8d8c55319c77)

### agent-base 9.0.0

- License: MIT
- URL: https://github.com/TooTallNate/proxy-agents/tree/HEAD/packages/agent-base
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [8d8c55319c77](#license-text-8d8c55319c77)

### ajv 8.20.0

- License: MIT
- URL: https://github.com/ajv-validator/ajv
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [f2fde84e6c1f](#license-text-f2fde84e6c1f)

### ajv-formats 3.0.1

- License: MIT
- URL: https://github.com/ajv-validator/ajv-formats
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [0eb7e0538bf8](#license-text-0eb7e0538bf8)

### aria-hidden 1.2.6

- License: MIT
- URL: https://github.com/theKashey/aria-hidden
- Shipped by: sedes
- License text (`LICENSE`): [07dfb46d2e36](#license-text-07dfb46d2e36)

### bail 2.0.2

- License: MIT
- URL: https://github.com/wooorm/bail
- Shipped by: sedes
- License text (`license`): [c37a32dd1cd4](#license-text-c37a32dd1cd4)

### balanced-match 4.0.4

- License: MIT
- URL: https://github.com/juliangruber/balanced-match
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.md`): [23b57495a1f9](#license-text-23b57495a1f9)

### base64-js 1.5.1

- License: MIT
- URL: https://github.com/beatgammit/base64-js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [ce471b4b8188](#license-text-ce471b4b8188)

### better-sqlite3 13.0.2

- License: MIT
- URL: https://github.com/WiseLibs/better-sqlite3
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [490ab72226a2](#license-text-490ab72226a2)

### bignumber.js 9.3.1

- License: MIT
- URL: https://github.com/MikeMcl/bignumber.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENCE.md`): [7ed7c157c417](#license-text-7ed7c157c417)

### body-parser 2.3.0

- License: MIT
- URL: https://github.com/expressjs/body-parser
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [7cb4d976f1c8](#license-text-7cb4d976f1c8)

### bowser 2.14.1

- License: MIT
- URL: https://github.com/bowser-js/bowser
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [0139f2c14d4e](#license-text-0139f2c14d4e)

### brace-expansion 5.0.9

- License: MIT
- URL: https://github.com/juliangruber/brace-expansion
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [f36e2da26df2](#license-text-f36e2da26df2)

### buffer-equal-constant-time 1.0.1

- License: BSD-3-Clause
- URL: https://github.com/goinstant/buffer-equal-constant-time
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.txt`): [2c44cee9bf9d](#license-text-2c44cee9bf9d)

### bytes 3.1.2

- License: MIT
- URL: https://github.com/visionmedia/bytes.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [811223f2d339](#license-text-811223f2d339)

### call-bind-apply-helpers 1.0.2

- License: MIT
- URL: https://github.com/ljharb/call-bind-apply-helpers
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [3df72862fb6d](#license-text-3df72862fb6d)

### call-bound 1.0.4

- License: MIT
- URL: https://github.com/ljharb/call-bound
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [3df72862fb6d](#license-text-3df72862fb6d)

### ccount 2.0.1

- License: MIT
- URL: https://github.com/wooorm/ccount
- Shipped by: sedes
- License text (`license`): [c37a32dd1cd4](#license-text-c37a32dd1cd4)

### chalk 6.0.0

- License: MIT
- URL: https://github.com/chalk/chalk
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`license`): [1529f88b3675](#license-text-1529f88b3675)

### character-entities 2.0.2

- License: MIT
- URL: https://github.com/wooorm/character-entities
- Shipped by: sedes
- License text (`license`): [c37a32dd1cd4](#license-text-c37a32dd1cd4)

### character-entities-html4 2.1.0

- License: MIT
- URL: https://github.com/wooorm/character-entities-html4
- Shipped by: sedes
- License text (`license`): [c37a32dd1cd4](#license-text-c37a32dd1cd4)

### character-entities-legacy 3.0.0

- License: MIT
- URL: https://github.com/wooorm/character-entities-legacy
- Shipped by: sedes
- License text (`license`): [c37a32dd1cd4](#license-text-c37a32dd1cd4)

### character-reference-invalid 2.0.1

- License: MIT
- URL: https://github.com/wooorm/character-reference-invalid
- Shipped by: sedes
- License text (`license`): [c37a32dd1cd4](#license-text-c37a32dd1cd4)

### class-variance-authority 0.7.1

- License: Apache-2.0
- URL: https://github.com/joe-bell/cva
- Shipped by: sedes
- License text (`LICENSE`): [be61dfc96bbf](#license-text-be61dfc96bbf)

### clsx 2.1.1

- License: MIT
- URL: https://github.com/lukeed/clsx
- Shipped by: sedes
- License text (`license`): [3d5b63706380](#license-text-3d5b63706380)

### comma-separated-tokens 2.0.3

- License: MIT
- URL: https://github.com/wooorm/comma-separated-tokens
- Shipped by: sedes
- License text (`license`): [d9c32f07344c](#license-text-d9c32f07344c)

### commander 7.2.0

- License: MIT
- URL: https://github.com/tj/commander.js
- Shipped by: sedes
- License text (`LICENSE`): [4cc9c2af4eb0](#license-text-4cc9c2af4eb0)

### commander 8.3.0

- License: MIT
- URL: https://github.com/tj/commander.js
- Shipped by: sedes
- License text (`LICENSE`): [4cc9c2af4eb0](#license-text-4cc9c2af4eb0)

### content-disposition 1.1.0

- License: MIT
- URL: https://github.com/jshttp/content-disposition
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [0696190d4967](#license-text-0696190d4967)

### content-type 1.0.5

- License: MIT
- URL: https://github.com/jshttp/content-type
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [fb06d5b872e5](#license-text-fb06d5b872e5)

### content-type 2.0.0

- License: MIT
- URL: https://github.com/jshttp/content-type
- Shipped by: sedes
- License text (`LICENSE`): [fb06d5b872e5](#license-text-fb06d5b872e5)

### content-type 2.1.0

- License: MIT
- URL: not declared in package metadata
- Shipped by: @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### cookie 0.7.2

- License: MIT
- URL: https://github.com/jshttp/cookie
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [b970cfe4a7f3](#license-text-b970cfe4a7f3)

### cookie-signature 1.2.2

- License: MIT
- URL: https://github.com/visionmedia/node-cookie-signature
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [bdbe1c003ac6](#license-text-bdbe1c003ac6)

### cors 2.8.6

- License: MIT
- URL: https://github.com/expressjs/cors
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [6efa74cb6d21](#license-text-6efa74cb6d21)

### cose-base 1.0.3

- License: MIT
- URL: https://github.com/iVis-at-Bilkent/cose-base
- Shipped by: sedes
- License text (`LICENSE`): [90ee3cca58da](#license-text-90ee3cca58da)

### cose-base 2.2.0

- License: MIT
- URL: https://github.com/iVis-at-Bilkent/cose-base
- Shipped by: sedes
- License text (`LICENSE`): [90ee3cca58da](#license-text-90ee3cca58da)

### cron-parser 5.6.0

- License: MIT
- URL: https://github.com/harrisiirak/cron-parser
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [9a08965c44ca](#license-text-9a08965c44ca)

### cross-spawn 7.0.6

- License: MIT
- URL: https://github.com/moxystudio/node-cross-spawn
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [5e7b89989b94](#license-text-5e7b89989b94)

### csstype 3.2.3

- License: MIT
- URL: https://github.com/frenic/csstype
- Shipped by: sedes
- License text (`LICENSE`): [6a972b33787e](#license-text-6a972b33787e)

### cytoscape 3.34.0

- License: MIT
- URL: https://github.com/cytoscape/cytoscape.js
- Shipped by: sedes
- License text (`LICENSE`): [eb319c6e6f23](#license-text-eb319c6e6f23)
- License text (`license-update.mjs`): [d4317f690ad0](#license-text-d4317f690ad0)

### cytoscape-cose-bilkent 4.1.0

- License: MIT
- URL: https://github.com/cytoscape/cytoscape.js-cose-bilkent
- Shipped by: sedes
- License text (`LICENSE`): [39b03b27e43a](#license-text-39b03b27e43a)

### cytoscape-fcose 2.2.0

- License: MIT
- URL: https://github.com/iVis-at-Bilkent/cytoscape.js-fcose
- Shipped by: sedes
- License text (`LICENSE`): [9f5ea8f5a268](#license-text-9f5ea8f5a268)

### d3 7.9.0

- License: ISC
- URL: https://github.com/d3/d3
- Shipped by: sedes
- License text (`LICENSE`): [f57e3a2cabf2](#license-text-f57e3a2cabf2)

### d3-array 2.12.1

- License: BSD-3-Clause
- URL: https://github.com/d3/d3-array
- Shipped by: sedes
- License text (`LICENSE`): [586409690da3](#license-text-586409690da3)

### d3-array 3.2.4

- License: ISC
- URL: https://github.com/d3/d3-array
- Shipped by: sedes
- License text (`LICENSE`): [f57e3a2cabf2](#license-text-f57e3a2cabf2)

### d3-axis 3.0.0

- License: ISC
- URL: https://github.com/d3/d3-axis
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-brush 3.0.0

- License: ISC
- URL: https://github.com/d3/d3-brush
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-chord 3.0.1

- License: ISC
- URL: https://github.com/d3/d3-chord
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-color 3.1.0

- License: ISC
- URL: https://github.com/d3/d3-color
- Shipped by: sedes
- License text (`LICENSE`): [4f4f9997e3d9](#license-text-4f4f9997e3d9)

### d3-contour 4.0.2

- License: ISC
- URL: https://github.com/d3/d3-contour
- Shipped by: sedes
- License text (`LICENSE`): [c8ea45f591c2](#license-text-c8ea45f591c2)

### d3-delaunay 6.0.4

- License: ISC
- URL: https://github.com/d3/d3-delaunay
- Shipped by: sedes
- License text (`LICENSE`): [4f8e381e74d4](#license-text-4f8e381e74d4)

### d3-dispatch 3.0.1

- License: ISC
- URL: https://github.com/d3/d3-dispatch
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-drag 3.0.0

- License: ISC
- URL: https://github.com/d3/d3-drag
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-dsv 3.0.1

- License: ISC
- URL: https://github.com/d3/d3-dsv
- Shipped by: sedes
- License text (`LICENSE`): [4c1cd1d0c4f8](#license-text-4c1cd1d0c4f8)

### d3-ease 3.0.1

- License: BSD-3-Clause
- URL: https://github.com/d3/d3-ease
- Shipped by: sedes
- License text (`LICENSE`): [69af84a0cb48](#license-text-69af84a0cb48)

### d3-fetch 3.0.1

- License: ISC
- URL: https://github.com/d3/d3-fetch
- Shipped by: sedes
- License text (`LICENSE`): [9d00baf34d17](#license-text-9d00baf34d17)

### d3-force 3.0.0

- License: ISC
- URL: https://github.com/d3/d3-force
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-format 3.1.2

- License: ISC
- URL: https://github.com/d3/d3-format
- Shipped by: sedes
- License text (`LICENSE`): [9fe3e95ca3e8](#license-text-9fe3e95ca3e8)

### d3-geo 3.1.1

- License: ISC
- URL: https://github.com/d3/d3-geo
- Shipped by: sedes
- License text (`LICENSE`): [e87ae4ac338d](#license-text-e87ae4ac338d)

### d3-hierarchy 3.1.2

- License: ISC
- URL: https://github.com/d3/d3-hierarchy
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-interpolate 3.0.1

- License: ISC
- URL: https://github.com/d3/d3-interpolate
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-path 1.0.9

- License: BSD-3-Clause
- URL: https://github.com/d3/d3-path
- Shipped by: sedes
- License text (`LICENSE`): [4b2513f280f3](#license-text-4b2513f280f3)

### d3-path 3.1.0

- License: ISC
- URL: https://github.com/d3/d3-path
- Shipped by: sedes
- License text (`LICENSE`): [58f959e2911c](#license-text-58f959e2911c)

### d3-polygon 3.0.1

- License: ISC
- URL: https://github.com/d3/d3-polygon
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-quadtree 3.0.1

- License: ISC
- URL: https://github.com/d3/d3-quadtree
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-random 3.0.1

- License: ISC
- URL: https://github.com/d3/d3-random
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-sankey 0.12.3

- License: BSD-3-Clause
- URL: https://github.com/d3/d3-sankey
- Shipped by: sedes
- License text (`LICENSE`): [38fdb5e42d48](#license-text-38fdb5e42d48)

### d3-scale 4.0.2

- License: ISC
- URL: https://github.com/d3/d3-scale
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-scale-chromatic 3.1.0

- License: ISC
- URL: https://github.com/d3/d3-scale-chromatic
- Shipped by: sedes
- License text (`LICENSE`): [1549638d9e45](#license-text-1549638d9e45)

### d3-selection 3.0.0

- License: ISC
- URL: https://github.com/d3/d3-selection
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-shape 1.3.7

- License: BSD-3-Clause
- URL: https://github.com/d3/d3-shape
- Shipped by: sedes
- License text (`LICENSE`): [50366760ca85](#license-text-50366760ca85)

### d3-shape 3.2.0

- License: ISC
- URL: https://github.com/d3/d3-shape
- Shipped by: sedes
- License text (`LICENSE`): [4f4f9997e3d9](#license-text-4f4f9997e3d9)

### d3-time 3.1.0

- License: ISC
- URL: https://github.com/d3/d3-time
- Shipped by: sedes
- License text (`LICENSE`): [4f4f9997e3d9](#license-text-4f4f9997e3d9)

### d3-time-format 4.1.0

- License: ISC
- URL: https://github.com/d3/d3-time-format
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-timer 3.0.1

- License: ISC
- URL: https://github.com/d3/d3-timer
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-transition 3.0.1

- License: ISC
- URL: https://github.com/d3/d3-transition
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### d3-zoom 3.0.0

- License: ISC
- URL: https://github.com/d3/d3-zoom
- Shipped by: sedes
- License text (`LICENSE`): [6019bf345195](#license-text-6019bf345195)

### dagre-d3-es 7.0.14

- License: MIT
- URL: https://github.com/tbo47/dagre-es
- Shipped by: sedes
- License text (`LICENSE.md`): [1521adecf617](#license-text-1521adecf617)

### data-uri-to-buffer 4.0.1

- License: MIT
- URL: https://github.com/TooTallNate/node-data-uri-to-buffer
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### dayjs 1.11.21

- License: MIT
- URL: https://github.com/iamkun/dayjs
- Shipped by: sedes
- License text (`LICENSE`): [16e34a46fa58](#license-text-16e34a46fa58)

### debug 4.4.3

- License: MIT
- URL: https://github.com/debug-js/debug
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d9e5aa2747f3](#license-text-d9e5aa2747f3)

### decode-named-character-reference 1.3.0

- License: MIT
- URL: https://github.com/wooorm/decode-named-character-reference
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### delaunator 5.1.0

- License: ISC
- URL: https://github.com/mapbox/delaunator
- Shipped by: sedes
- License text (`LICENSE`): [2c5fce57341d](#license-text-2c5fce57341d)

### depd 2.0.0

- License: MIT
- URL: https://github.com/dougwilson/nodejs-depd
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [f889cb863a1f](#license-text-f889cb863a1f)

### dequal 2.0.3

- License: MIT
- URL: https://github.com/lukeed/dequal
- Shipped by: sedes
- License text (`license`): [d0a8e5996a99](#license-text-d0a8e5996a99)

### detect-node-es 1.1.0

- License: MIT
- URL: https://github.com/thekashey/detect-node
- Shipped by: sedes
- License text (`LICENSE`): [5dd2a43c0ed6](#license-text-5dd2a43c0ed6)

### devlop 1.1.0

- License: MIT
- URL: https://github.com/wooorm/devlop
- Shipped by: sedes
- License text (`license`): [189cbd7c4b22](#license-text-189cbd7c4b22)

### diff 8.0.4

- License: BSD-3-Clause
- URL: https://github.com/kpdecker/jsdiff
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [ef7eb99d9a97](#license-text-ef7eb99d9a97)

### diff 9.0.0

- License: BSD-3-Clause
- URL: https://github.com/kpdecker/jsdiff
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [ef7eb99d9a97](#license-text-ef7eb99d9a97)

### dompurify 3.4.13

- License: (MPL-2.0 OR Apache-2.0)
- URL: https://github.com/cure53/DOMPurify
- Shipped by: sedes
- License text (`LICENSE`): [283ea6cc2997](#license-text-283ea6cc2997)
- License text (`LICENSE-MPL`): [4b89d4518bd1](#license-text-4b89d4518bd1)

### dunder-proto 1.0.1

- License: MIT
- URL: https://github.com/es-shims/dunder-proto
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [42fbee6b9cc2](#license-text-42fbee6b9cc2)

### ecdsa-sig-formatter 1.0.11

- License: Apache-2.0
- URL: https://github.com/Brightspace/node-ecdsa-sig-formatter
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [50640bbffc17](#license-text-50640bbffc17)

### ee-first 1.1.1

- License: MIT
- URL: https://github.com/jonathanong/ee-first
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d68cfda21300](#license-text-d68cfda21300)

### encodeurl 2.0.0

- License: MIT
- URL: https://github.com/pillarjs/encodeurl
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [b4d257dd0d1c](#license-text-b4d257dd0d1c)

### es-define-property 1.0.1

- License: MIT
- URL: https://github.com/ljharb/es-define-property
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [3df72862fb6d](#license-text-3df72862fb6d)

### es-errors 1.3.0

- License: MIT
- URL: https://github.com/ljharb/es-errors
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [3df72862fb6d](#license-text-3df72862fb6d)

### es-object-atoms 1.1.2

- License: MIT
- URL: https://github.com/ljharb/es-object-atoms
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [3df72862fb6d](#license-text-3df72862fb6d)

### es-toolkit 1.50.0

- License: MIT
- URL: https://github.com/toss/es-toolkit
- Shipped by: sedes
- License text (`LICENSE`): [02f3b7dba54e](#license-text-02f3b7dba54e)

### esbuild 0.28.2

- License: MIT
- URL: https://github.com/evanw/esbuild
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.md`): [f2b90afb27a6](#license-text-f2b90afb27a6)

### escape-html 1.0.3

- License: MIT
- URL: https://github.com/component/escape-html
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [b2bf1d8ed89e](#license-text-b2bf1d8ed89e)

### escape-string-regexp 5.0.0

- License: MIT
- URL: https://github.com/sindresorhus/escape-string-regexp
- Shipped by: sedes
- License text (`license`): [1529f88b3675](#license-text-1529f88b3675)

### estree-util-is-identifier-name 3.0.0

- License: MIT
- URL: https://github.com/syntax-tree/estree-util-is-identifier-name
- Shipped by: sedes
- License text (`license`): [0e99f2710dd2](#license-text-0e99f2710dd2)

### etag 1.8.1

- License: MIT
- URL: https://github.com/jshttp/etag
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [49fa72ab1de5](#license-text-49fa72ab1de5)

### eventsource 3.0.7

- License: MIT
- URL: https://git@github.com/EventSource/eventsource
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [e4f413b3ca5e](#license-text-e4f413b3ca5e)

### eventsource-parser 3.1.0

- License: MIT
- URL: https://github.com/rexxars/eventsource-parser
- Shipped by: sedes
- License text (`LICENSE`): [39813fa23b19](#license-text-39813fa23b19)

### eventsource-parser 3.1.1

- License: MIT
- URL: not declared in package metadata
- Shipped by: @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### express 5.2.1

- License: MIT
- URL: https://github.com/expressjs/express
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [93321073ebe5](#license-text-93321073ebe5)

### express-rate-limit 8.6.1

- License: MIT
- URL: https://github.com/express-rate-limit/express-rate-limit
- Shipped by: sedes
- License text (`license.md`): [21406f0433c8](#license-text-21406f0433c8)

### express-rate-limit 8.7.0

- License: MIT
- URL: not declared in package metadata
- Shipped by: @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### extend 3.0.2

- License: MIT
- URL: https://github.com/justmoon/node-extend
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [b079b743d39a](#license-text-b079b743d39a)

### fast-deep-equal 3.1.3

- License: MIT
- URL: https://github.com/epoberezkin/fast-deep-equal
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [aa407ee69b3f](#license-text-aa407ee69b3f)

### fast-sha256 1.3.0

- License: Unlicense
- URL: https://github.com/dchest/fast-sha256-js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [79d0fc447160](#license-text-79d0fc447160)

### fast-uri 3.1.5

- License: BSD-3-Clause
- URL: https://github.com/fastify/fast-uri
- Shipped by: sedes
- License text (`LICENSE`): [b010b0dfdfdb](#license-text-b010b0dfdfdb)

### fast-uri 3.1.6

- License: BSD-3-Clause
- URL: not declared in package metadata
- Shipped by: @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### fetch-blob 3.2.0

- License: MIT
- URL: https://github.com/node-fetch/fetch-blob
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [da98afd61ac8](#license-text-da98afd61ac8)

### finalhandler 2.1.1

- License: MIT
- URL: https://github.com/pillarjs/finalhandler
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [887ee21f80fd](#license-text-887ee21f80fd)

### formdata-polyfill 4.0.10

- License: MIT
- URL: https://jimmywarting@github.com/jimmywarting/FormData
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [95b423fd389e](#license-text-95b423fd389e)

### forwarded 0.2.0

- License: MIT
- URL: https://github.com/jshttp/forwarded
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [0696190d4967](#license-text-0696190d4967)

### fresh 2.0.0

- License: MIT
- URL: https://github.com/jshttp/fresh
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [72bb6356e9ef](#license-text-72bb6356e9ef)

### function-bind 1.1.2

- License: MIT
- URL: https://github.com/Raynos/function-bind
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [741668cc2214](#license-text-741668cc2214)

### gaxios 7.1.4

- License: Apache-2.0
- URL: https://github.com/googleapis/google-cloud-node-core/tree/HEAD/packages/gaxios
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [283ea6cc2997](#license-text-283ea6cc2997)

### gaxios 7.3.1

- License: Apache-2.0
- URL: https://github.com/googleapis/google-cloud-node/tree/HEAD/core/packages/gaxios
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [283ea6cc2997](#license-text-283ea6cc2997)

### gcp-metadata 8.1.2

- License: Apache-2.0
- URL: https://github.com/googleapis/google-cloud-node-core/tree/HEAD/packages/gcp-metadata
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [283ea6cc2997](#license-text-283ea6cc2997)

### get-east-asian-width 1.6.0

- License: MIT
- URL: https://github.com/sindresorhus/get-east-asian-width
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`license`): [1529f88b3675](#license-text-1529f88b3675)

### get-intrinsic 1.3.0

- License: MIT
- URL: https://github.com/ljharb/get-intrinsic
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [006a2e42087f](#license-text-006a2e42087f)

### get-nonce 1.0.1

- License: MIT
- URL: https://github.com/theKashey/get-nonce
- Shipped by: sedes
- License text (`LICENSE`): [a05c505267a8](#license-text-a05c505267a8)

### get-proto 1.0.1

- License: MIT
- URL: https://github.com/ljharb/get-proto
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [c09860913a77](#license-text-c09860913a77)

### ghostty-web 0.4.0

- License: MIT
- URL: https://github.com/coder/ghostty-web
- Shipped by: sedes
- License text (`LICENSE`): [f3166fa57273](#license-text-f3166fa57273)

### google-auth-library 10.6.2

- License: Apache-2.0
- URL: https://github.com/googleapis/google-cloud-node-core/tree/HEAD/packages/google-auth-library-nodejs
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [283ea6cc2997](#license-text-283ea6cc2997)

### google-auth-library 10.9.1

- License: Apache-2.0
- URL: https://github.com/googleapis/google-cloud-node/tree/HEAD/core/packages/google-auth-library-nodejs
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [283ea6cc2997](#license-text-283ea6cc2997)

### google-logging-utils 1.1.3

- License: Apache-2.0
- URL: https://github.com/googleapis/google-cloud-node-core/tree/HEAD/dev-packages/logging-utils
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [283ea6cc2997](#license-text-283ea6cc2997)

### gopd 1.2.0

- License: MIT
- URL: https://github.com/ljharb/gopd
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [3f7cd27a6e50](#license-text-3f7cd27a6e50)

### graceful-fs 4.2.11

- License: ISC
- URL: https://github.com/isaacs/node-graceful-fs
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [740bb4e91297](#license-text-740bb4e91297)

### grok-mermaid 0.2.3

- License: Apache-2.0
- URL: https://github.com/xl0/grok-mermaid
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [ac29541ee357](#license-text-ac29541ee357)

### hachure-fill 0.5.2

- License: MIT
- URL: https://github.com/pshihn/hachure-fill
- Shipped by: sedes
- License text (`LICENSE`): [d3de97fbfe54](#license-text-d3de97fbfe54)

### has-symbols 1.1.0

- License: MIT
- URL: https://github.com/inspect-js/has-symbols
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [fdb3f0dc5ffa](#license-text-fdb3f0dc5ffa)

### hasown 2.0.4

- License: MIT
- URL: https://github.com/inspect-js/hasOwn
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [928a86b1d298](#license-text-928a86b1d298)

### hast-util-to-html 9.0.5

- License: MIT
- URL: https://github.com/syntax-tree/hast-util-to-html
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### hast-util-to-jsx-runtime 2.3.6

- License: MIT
- URL: https://github.com/syntax-tree/hast-util-to-jsx-runtime
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### hast-util-whitespace 3.0.0

- License: MIT
- URL: https://github.com/syntax-tree/hast-util-whitespace
- Shipped by: sedes
- License text (`license`): [d9c32f07344c](#license-text-d9c32f07344c)

### highlight.js 10.7.3

- License: BSD-3-Clause
- URL: https://github.com/highlightjs/highlight.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [eabb8d3cadaf](#license-text-eabb8d3cadaf)

### hono 4.12.32

- License: MIT
- URL: https://github.com/honojs/hono
- Shipped by: sedes
- License text (`LICENSE`): [2e0a854a1106](#license-text-2e0a854a1106)

### hono 4.13.5

- License: MIT
- URL: not declared in package metadata
- Shipped by: @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### hosted-git-info 9.0.3

- License: ISC
- URL: https://github.com/npm/hosted-git-info
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d28e1b882ecc](#license-text-d28e1b882ecc)

### html-url-attributes 3.0.1

- License: MIT
- URL: https://github.com/rehypejs/rehype-minify/tree/main/packages/html-url-attributes
- Shipped by: sedes
- License text (`license`): [2cf2d507c76c](#license-text-2cf2d507c76c)

### html-void-elements 3.0.0

- License: MIT
- URL: https://github.com/wooorm/html-void-elements
- Shipped by: sedes
- License text (`license`): [d9c32f07344c](#license-text-d9c32f07344c)

### http-errors 2.0.1

- License: MIT
- URL: https://github.com/jshttp/http-errors
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [b279be1458cd](#license-text-b279be1458cd)

### http-proxy-agent 9.1.0

- License: MIT
- URL: https://github.com/TooTallNate/proxy-agents/tree/HEAD/packages/http-proxy-agent
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [8d8c55319c77](#license-text-8d8c55319c77)

### https-proxy-agent 7.0.6

- License: MIT
- URL: https://github.com/TooTallNate/proxy-agents/tree/HEAD/packages/https-proxy-agent
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [8d8c55319c77](#license-text-8d8c55319c77)

### https-proxy-agent 9.1.0

- License: MIT
- URL: https://github.com/TooTallNate/proxy-agents/tree/HEAD/packages/https-proxy-agent
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [8d8c55319c77](#license-text-8d8c55319c77)

### iconv-lite 0.6.3

- License: MIT
- URL: https://github.com/ashtuchkin/iconv-lite
- Shipped by: sedes
- License text (`LICENSE`): [48186f5950f2](#license-text-48186f5950f2)

### iconv-lite 0.7.3

- License: MIT
- URL: https://github.com/pillarjs/iconv-lite
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [48186f5950f2](#license-text-48186f5950f2)

### ignore 7.0.8

- License: MIT
- URL: https://github.com/kaelzhang/node-ignore
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE-MIT`): [9c94db23dc4b](#license-text-9c94db23dc4b)

### import-meta-resolve 4.2.0

- License: MIT
- URL: https://github.com/wooorm/import-meta-resolve
- Shipped by: sedes
- License text (`license`): [396681618aa8](#license-text-396681618aa8)

### inherits 2.0.4

- License: ISC
- URL: https://github.com/isaacs/inherits
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [3a395674c5c9](#license-text-3a395674c5c9)

### inline-style-parser 0.2.7

- License: MIT
- URL: https://github.com/remarkablemark/inline-style-parser
- Shipped by: sedes
- License text (`LICENSE`): [9cac2500def4](#license-text-9cac2500def4)

### internmap 1.0.1

- License: ISC
- URL: https://github.com/mbostock/internmap
- Shipped by: sedes
- License text (`LICENSE`): [f4bb8f655fdb](#license-text-f4bb8f655fdb)

### internmap 2.0.3

- License: ISC
- URL: https://github.com/mbostock/internmap
- Shipped by: sedes
- License text (`LICENSE`): [f4bb8f655fdb](#license-text-f4bb8f655fdb)

### ip-address 10.4.0

- License: MIT
- URL: https://github.com/beaugunderson/ip-address
- Shipped by: sedes
- License text (`LICENSE`): [02d42589c644](#license-text-02d42589c644)

### ip-address 10.5.1

- License: MIT
- URL: not declared in package metadata
- Shipped by: @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### ipaddr.js 1.9.1

- License: MIT
- URL: https://github.com/whitequark/ipaddr.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [ad66ea5b7919](#license-text-ad66ea5b7919)

### is-alphabetical 2.0.1

- License: MIT
- URL: https://github.com/wooorm/is-alphabetical
- Shipped by: sedes
- License text (`license`): [d9c32f07344c](#license-text-d9c32f07344c)

### is-alphanumerical 2.0.1

- License: MIT
- URL: https://github.com/wooorm/is-alphanumerical
- Shipped by: sedes
- License text (`license`): [d9c32f07344c](#license-text-d9c32f07344c)

### is-decimal 2.0.1

- License: MIT
- URL: https://github.com/wooorm/is-decimal
- Shipped by: sedes
- License text (`license`): [d9c32f07344c](#license-text-d9c32f07344c)

### is-hexadecimal 2.0.1

- License: MIT
- URL: https://github.com/wooorm/is-hexadecimal
- Shipped by: sedes
- License text (`license`): [d9c32f07344c](#license-text-d9c32f07344c)

### is-plain-obj 4.1.0

- License: MIT
- URL: https://github.com/sindresorhus/is-plain-obj
- Shipped by: sedes
- License text (`license`): [1529f88b3675](#license-text-1529f88b3675)

### is-promise 4.0.0

- License: MIT
- URL: https://github.com/then/is-promise
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [44191656d296](#license-text-44191656d296)

### isexe 2.0.0

- License: ISC
- URL: https://github.com/isaacs/isexe
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [0ae52fe329cc](#license-text-0ae52fe329cc)

### jiti 2.7.0

- License: MIT
- URL: https://github.com/unjs/jiti
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [f7673e959327](#license-text-f7673e959327)

### jose 6.2.10

- License: MIT
- URL: not declared in package metadata
- Shipped by: @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### jose 6.2.5

- License: MIT
- URL: https://github.com/panva/jose
- Shipped by: sedes
- License text (`LICENSE.md`): [d6f4fc856b99](#license-text-d6f4fc856b99)

### json-bigint 1.0.0

- License: MIT
- URL: https://github.com/sidorares/json-bigint
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [faa1180b6bfe](#license-text-faa1180b6bfe)

### json-schema-to-ts 3.1.1

- License: MIT
- URL: https://github.com/ThomasAribart/json-schema-to-ts
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [3d1a950648d8](#license-text-3d1a950648d8)

### json-schema-traverse 1.0.0

- License: MIT
- URL: https://github.com/epoberezkin/json-schema-traverse
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [aa407ee69b3f](#license-text-aa407ee69b3f)

### json-schema-typed 8.0.2

- License: BSD-2-Clause
- URL: https://github.com/RemyRylan/json-schema-typed
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.md`): [ff750f6d635d](#license-text-ff750f6d635d)

### jwa 2.0.1

- License: MIT
- URL: https://github.com/brianloveswords/node-jwa
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [f175d4a76efe](#license-text-f175d4a76efe)

### jws 4.0.1

- License: MIT
- URL: https://github.com/brianloveswords/node-jws
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [f175d4a76efe](#license-text-f175d4a76efe)

### katex 0.16.47

- License: MIT
- URL: https://github.com/KaTeX/KaTeX
- Shipped by: sedes
- License text (`LICENSE`): [d3c8c167dfa0](#license-text-d3c8c167dfa0)

### khroma 2.1.0

- License: not declared in package metadata
- URL: https://github.com/fabiospampinato/khroma
- Shipped by: sedes
- License text (`license`): [5135f3f76071](#license-text-5135f3f76071)

### layout-base 1.0.2

- License: MIT
- URL: https://github.com/iVis-at-Bilkent/layout-base
- Shipped by: sedes
- License text (`LICENSE`): [6dfc8a41d27c](#license-text-6dfc8a41d27c)

### layout-base 2.0.1

- License: MIT
- URL: https://github.com/iVis-at-Bilkent/layout-base
- Shipped by: sedes
- License text (`LICENSE`): [6dfc8a41d27c](#license-text-6dfc8a41d27c)

### lodash-es 4.18.1

- License: MIT
- URL: https://github.com/lodash/lodash
- Shipped by: sedes
- License text (`LICENSE`): [2314aa0e2bae](#license-text-2314aa0e2bae)

### long 5.3.2

- License: Apache-2.0
- URL: https://github.com/dcodeIO/long.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [283ea6cc2997](#license-text-283ea6cc2997)

### longest-streak 3.1.0

- License: MIT
- URL: https://github.com/wooorm/longest-streak
- Shipped by: sedes
- License text (`license`): [4be46afa7981](#license-text-4be46afa7981)

### lru_map 0.4.1

- License: MIT
- URL: https://github.com/rsms/js-lru
- Shipped by: sedes
- License text: license text not included in package; see repository

### lru-cache 11.4.0

- License: BlueOak-1.0.0
- URL: https://github.com/isaacs/node-lru-cache
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.md`): [1a9975c75cfc](#license-text-1a9975c75cfc)

### lucide-react 1.27.0

- License: ISC
- URL: https://github.com/lucide-icons/lucide/tree/HEAD/packages/lucide-react
- Shipped by: sedes
- License text (`LICENSE`): [ee35498e6684](#license-text-ee35498e6684)

### luxon 3.7.2

- License: MIT
- URL: https://github.com/moment/luxon
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.md`): [f8f62778c92d](#license-text-f8f62778c92d)

### markdown-table 3.0.4

- License: MIT
- URL: https://github.com/wooorm/markdown-table
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### marked 16.4.2

- License: MIT
- URL: https://github.com/markedjs/marked
- Shipped by: sedes
- License text (`LICENSE.md`): [dd923de97698](#license-text-dd923de97698)

### marked 18.0.11

- License: MIT
- URL: https://github.com/markedjs/marked
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [dd923de97698](#license-text-dd923de97698)

### math-intrinsics 1.1.0

- License: MIT
- URL: https://github.com/es-shims/math-intrinsics
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [42fbee6b9cc2](#license-text-42fbee6b9cc2)

### mdast-util-find-and-replace 3.0.2

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-find-and-replace
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### mdast-util-from-markdown 2.0.3

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-from-markdown
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### mdast-util-gfm 3.1.0

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-gfm
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### mdast-util-gfm-autolink-literal 2.0.1

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-gfm-autolink-literal
- Shipped by: sedes
- License text (`license`): [0e99f2710dd2](#license-text-0e99f2710dd2)

### mdast-util-gfm-footnote 2.1.0

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-gfm-footnote
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### mdast-util-gfm-strikethrough 2.0.0

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-gfm-strikethrough
- Shipped by: sedes
- License text (`license`): [0e99f2710dd2](#license-text-0e99f2710dd2)

### mdast-util-gfm-table 2.0.0

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-gfm-table
- Shipped by: sedes
- License text (`license`): [0e99f2710dd2](#license-text-0e99f2710dd2)

### mdast-util-gfm-task-list-item 2.0.0

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-gfm-task-list-item
- Shipped by: sedes
- License text (`license`): [0e99f2710dd2](#license-text-0e99f2710dd2)

### mdast-util-mdx-expression 2.0.1

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-mdx-expression
- Shipped by: sedes
- License text (`license`): [0e99f2710dd2](#license-text-0e99f2710dd2)

### mdast-util-mdx-jsx 3.2.0

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-mdx-jsx
- Shipped by: sedes
- License text (`license`): [0e99f2710dd2](#license-text-0e99f2710dd2)

### mdast-util-mdxjs-esm 2.0.1

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-mdxjs-esm
- Shipped by: sedes
- License text (`license`): [0e99f2710dd2](#license-text-0e99f2710dd2)

### mdast-util-phrasing 4.1.0

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-phrasing
- Shipped by: sedes
- License text (`license`): [e11634cfe7bf](#license-text-e11634cfe7bf)

### mdast-util-to-hast 13.2.1

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-to-hast
- Shipped by: sedes
- License text (`license`): [d9c32f07344c](#license-text-d9c32f07344c)

### mdast-util-to-markdown 2.1.2

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-to-markdown
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### mdast-util-to-string 4.0.0

- License: MIT
- URL: https://github.com/syntax-tree/mdast-util-to-string
- Shipped by: sedes
- License text (`license`): [c37a32dd1cd4](#license-text-c37a32dd1cd4)

### media-typer 1.1.1

- License: MIT
- URL: https://github.com/jshttp/media-typer
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [0696190d4967](#license-text-0696190d4967)

### merge-descriptors 2.0.0

- License: MIT
- URL: https://github.com/sindresorhus/merge-descriptors
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`license`): [d48d15a12e71](#license-text-d48d15a12e71)

### mermaid 11.16.1

- License: MIT
- URL: https://github.com/mermaid-js/mermaid
- Shipped by: sedes
- License text (`LICENSE`): [94228ab8fc0b](#license-text-94228ab8fc0b)

### micromark 4.0.2

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-core-commonmark 2.0.3

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-core-commonmark
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-extension-gfm 3.0.0

- License: MIT
- URL: https://github.com/micromark/micromark-extension-gfm
- Shipped by: sedes
- License text (`license`): [0e99f2710dd2](#license-text-0e99f2710dd2)

### micromark-extension-gfm-autolink-literal 2.1.0

- License: MIT
- URL: https://github.com/micromark/micromark-extension-gfm-autolink-literal
- Shipped by: sedes
- License text (`license`): [0e99f2710dd2](#license-text-0e99f2710dd2)

### micromark-extension-gfm-footnote 2.1.0

- License: MIT
- URL: https://github.com/micromark/micromark-extension-gfm-footnote
- Shipped by: sedes
- License text (`license`): [59e8b888f1d3](#license-text-59e8b888f1d3)

### micromark-extension-gfm-strikethrough 2.1.0

- License: MIT
- URL: https://github.com/micromark/micromark-extension-gfm-strikethrough
- Shipped by: sedes
- License text (`license`): [0e99f2710dd2](#license-text-0e99f2710dd2)

### micromark-extension-gfm-table 2.1.1

- License: MIT
- URL: https://github.com/micromark/micromark-extension-gfm-table
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-extension-gfm-tagfilter 2.0.0

- License: MIT
- URL: https://github.com/micromark/micromark-extension-gfm-tagfilter
- Shipped by: sedes
- License text (`license`): [0e99f2710dd2](#license-text-0e99f2710dd2)

### micromark-extension-gfm-task-list-item 2.1.0

- License: MIT
- URL: https://github.com/micromark/micromark-extension-gfm-task-list-item
- Shipped by: sedes
- License text (`license`): [0e99f2710dd2](#license-text-0e99f2710dd2)

### micromark-factory-destination 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-factory-destination
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-factory-label 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-factory-label
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-factory-space 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-factory-space
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-factory-title 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-factory-title
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-factory-whitespace 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-factory-whitespace
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-character 2.1.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-character
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-chunked 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-chunked
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-classify-character 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-classify-character
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-combine-extensions 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-combine-extensions
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-decode-numeric-character-reference 2.0.2

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-numeric-character-reference
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-decode-string 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-string
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-encode 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-encode
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-html-tag-name 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-html-tag-name
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-normalize-identifier 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-normalize-identifier
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-resolve-all 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-resolve-all
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-sanitize-uri 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-sanitize-uri
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-subtokenize 2.1.0

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-subtokenize
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-symbol 2.0.1

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-symbol
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### micromark-util-types 2.0.2

- License: MIT
- URL: https://github.com/micromark/micromark/tree/main/packages/micromark-util-types
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### mime-db 1.54.0

- License: MIT
- URL: https://github.com/jshttp/mime-db
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [9116bd624634](#license-text-9116bd624634)

### mime-types 3.0.2

- License: MIT
- URL: https://github.com/jshttp/mime-types
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [a3fb4c94aaf6](#license-text-a3fb4c94aaf6)

### minimatch 10.2.6

- License: BlueOak-1.0.0
- URL: https://github.com/isaacs/minimatch
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.md`): [aa4c6585f201](#license-text-aa4c6585f201)

### ms 2.1.3

- License: MIT
- URL: https://github.com/vercel/ms
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`license.md`): [e91069c31b4e](#license-text-e91069c31b4e)

### negotiator 1.0.0

- License: MIT
- URL: https://github.com/jshttp/negotiator
- Shipped by: sedes
- License text (`LICENSE`): [8a160f8ccc7b](#license-text-8a160f8ccc7b)

### negotiator 1.1.0

- License: MIT
- URL: not declared in package metadata
- Shipped by: @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### node-addon-api 7.1.1

- License: MIT
- URL: https://github.com/nodejs/node-addon-api
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.md`): [1d660eff8965](#license-text-1d660eff8965)

### node-addon-api 8.9.0

- License: MIT
- URL: https://github.com/nodejs/node-addon-api
- Shipped by: sedes
- License text (`LICENSE.md`): [1d660eff8965](#license-text-1d660eff8965)

### node-addon-api 8.9.2

- License: MIT
- URL: not declared in package metadata
- Shipped by: @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### node-domexception 1.0.0

- License: MIT
- URL: https://github.com/jimmywarting/node-domexception
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [8c46e0985782](#license-text-8c46e0985782)

### node-fetch 3.3.2

- License: MIT
- URL: https://github.com/node-fetch/node-fetch
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.md`): [399cbcc4b8a2](#license-text-399cbcc4b8a2)

### node-pty 1.1.0

- License: MIT
- URL: https://github.com/microsoft/node-pty
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [cab518dd82c2](#license-text-cab518dd82c2)

### object-assign 4.1.1

- License: MIT
- URL: https://github.com/sindresorhus/object-assign
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`license`): [2bc4beb49d48](#license-text-2bc4beb49d48)

### object-inspect 1.13.4

- License: MIT
- URL: https://github.com/inspect-js/object-inspect
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [dd58f6060d93](#license-text-dd58f6060d93)

### on-finished 2.4.1

- License: MIT
- URL: https://github.com/jshttp/on-finished
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [5de22a7021a0](#license-text-5de22a7021a0)

### once 1.4.0

- License: ISC
- URL: https://github.com/isaacs/once
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [0ae52fe329cc](#license-text-0ae52fe329cc)

### oniguruma-parser 0.12.2

- License: MIT
- URL: https://github.com/slevithan/oniguruma-parser
- Shipped by: sedes
- License text (`LICENSE`): [a73647cf797f](#license-text-a73647cf797f)

### oniguruma-to-es 4.3.6

- License: MIT
- URL: https://github.com/slevithan/oniguruma-to-es
- Shipped by: sedes
- License text (`LICENSE`): [84a6a26e0f60](#license-text-84a6a26e0f60)

### openai 6.40.0

- License: Apache-2.0
- URL: https://github.com/openai/openai-node
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [7d52eae0c2f0](#license-text-7d52eae0c2f0)

### p-retry 4.6.2

- License: MIT
- URL: https://github.com/sindresorhus/p-retry
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`license`): [c9808a775260](#license-text-c9808a775260)

### package-manager-detector 1.8.0

- License: MIT
- URL: https://github.com/antfu-collective/package-manager-detector
- Shipped by: sedes
- License text (`LICENSE`): [ac1f2978a646](#license-text-ac1f2978a646)

### parse-entities 4.0.2

- License: MIT
- URL: https://github.com/wooorm/parse-entities
- Shipped by: sedes
- License text (`license`): [c74f9c5a522f](#license-text-c74f9c5a522f)

### parseurl 1.3.3

- License: MIT
- URL: https://github.com/pillarjs/parseurl
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [9179082f29f0](#license-text-9179082f29f0)

### partial-json 0.1.7

- License: MIT
- URL: https://github.com/promplate/partial-json-parser-js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [b72c84b52e8f](#license-text-b72c84b52e8f)

### path-data-parser 0.1.0

- License: MIT
- URL: https://github.com/pshihn/path-data-parser
- Shipped by: sedes
- License text (`LICENSE`): [a734fd0e3f64](#license-text-a734fd0e3f64)

### path-key 3.1.1

- License: MIT
- URL: https://github.com/sindresorhus/path-key
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`license`): [c9808a775260](#license-text-c9808a775260)

### path-to-regexp 8.4.2

- License: MIT
- URL: https://github.com/pillarjs/path-to-regexp
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [e257f36bcf5e](#license-text-e257f36bcf5e)

### pkce-challenge 5.0.1

- License: MIT
- URL: https://github.com/crouchcd/pkce-challenge
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [64c4e54df59c](#license-text-64c4e54df59c)

### points-on-curve 0.2.0

- License: MIT
- URL: https://github.com/pshihn/bezier-points
- Shipped by: sedes
- License text (`LICENSE`): [a734fd0e3f64](#license-text-a734fd0e3f64)

### points-on-path 0.2.1

- License: MIT
- URL: https://github.com/pshihn/points-on-path
- Shipped by: sedes
- License text (`LICENSE`): [05a601c405df](#license-text-05a601c405df)

### preact 11.0.0-beta.0

- License: MIT
- URL: https://github.com/preactjs/preact
- Shipped by: sedes
- License text (`LICENSE`): [ecc934075c78](#license-text-ecc934075c78)

### preact-render-to-string 6.6.5

- License: MIT
- URL: https://github.com/preactjs/preact-render-to-string
- Shipped by: sedes
- License text (`LICENSE`): [90f7e57f32c5](#license-text-90f7e57f32c5)

### proper-lockfile 4.1.2

- License: MIT
- URL: https://github.com/moxystudio/node-proper-lockfile
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [5e7b89989b94](#license-text-5e7b89989b94)

### property-information 7.2.0

- License: MIT
- URL: https://github.com/wooorm/property-information
- Shipped by: sedes
- License text (`license`): [c74f9c5a522f](#license-text-c74f9c5a522f)

### protobufjs 7.6.6

- License: BSD-3-Clause
- URL: https://github.com/protobufjs/protobuf.js
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [79157668b360](#license-text-79157668b360)

### proxy-addr 2.0.7

- License: MIT
- URL: https://github.com/jshttp/proxy-addr
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [49fa72ab1de5](#license-text-49fa72ab1de5)

### proxy-agent-negotiate 1.1.0

- License: MIT
- URL: https://github.com/TooTallNate/proxy-agents/tree/HEAD/packages/negotiate
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### qs 6.15.3

- License: BSD-3-Clause
- URL: https://github.com/ljharb/qs
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.md`): [14d069c68fe7](#license-text-14d069c68fe7)

### radix-ui 1.6.7

- License: MIT
- URL: https://github.com/radix-ui/primitives/tree/HEAD/packages/react/radix-ui
- Shipped by: sedes
- License text (`LICENSE`): [74144f6a3a6c](#license-text-74144f6a3a6c)

### range-parser 1.3.0

- License: MIT
- URL: https://github.com/jshttp/range-parser
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [98a2c2007296](#license-text-98a2c2007296)

### raw-body 3.0.2

- License: MIT
- URL: https://github.com/stream-utils/raw-body
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [b5954f59305d](#license-text-b5954f59305d)

### react 19.2.8

- License: MIT
- URL: https://github.com/react/react/tree/HEAD/packages/react
- Shipped by: sedes
- License text (`LICENSE`): [cf9b17822d1f](#license-text-cf9b17822d1f)

### react-dom 19.2.8

- License: MIT
- URL: https://github.com/react/react/tree/HEAD/packages/react-dom
- Shipped by: sedes
- License text (`LICENSE`): [cf9b17822d1f](#license-text-cf9b17822d1f)

### react-markdown 10.1.0

- License: MIT
- URL: https://github.com/remarkjs/react-markdown
- Shipped by: sedes
- License text (`license`): [b7972f57b949](#license-text-b7972f57b949)

### react-remove-scroll 2.7.2

- License: MIT
- URL: https://github.com/theKashey/react-remove-scroll
- Shipped by: sedes
- License text (`LICENSE`): [07dfb46d2e36](#license-text-07dfb46d2e36)

### react-remove-scroll-bar 2.3.8

- License: MIT
- URL: https://github.com/theKashey/react-remove-scroll-bar
- Shipped by: sedes
- License text: license text not included in package; see repository

### react-style-singleton 2.2.3

- License: MIT
- URL: https://github.com/theKashey/react-style-singleton
- Shipped by: sedes
- License text (`LICENSE`): [07dfb46d2e36](#license-text-07dfb46d2e36)

### regex 6.1.0

- License: MIT
- URL: https://github.com/slevithan/regex
- Shipped by: sedes
- License text (`LICENSE`): [f526adb7b81e](#license-text-f526adb7b81e)

### regex-recursion 6.0.2

- License: MIT
- URL: https://github.com/slevithan/regex-recursion
- Shipped by: sedes
- License text (`LICENSE`): [f526adb7b81e](#license-text-f526adb7b81e)

### regex-utilities 2.3.0

- License: MIT
- URL: https://github.com/slevithan/regex-utilities
- Shipped by: sedes
- License text (`LICENSE`): [4b47df8ec858](#license-text-4b47df8ec858)

### remark-gfm 4.0.1

- License: MIT
- URL: https://github.com/remarkjs/remark-gfm
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### remark-parse 11.0.0

- License: MIT
- URL: https://github.com/remarkjs/remark/tree/main/packages/remark-parse
- Shipped by: sedes
- License text (`license`): [f78777570e32](#license-text-f78777570e32)

### remark-rehype 11.1.2

- License: MIT
- URL: https://github.com/remarkjs/remark-rehype
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### remark-stringify 11.0.0

- License: MIT
- URL: https://github.com/remarkjs/remark/tree/main/packages/remark-stringify
- Shipped by: sedes
- License text (`license`): [f78777570e32](#license-text-f78777570e32)

### require-from-string 2.0.2

- License: MIT
- URL: https://github.com/floatdrop/require-from-string
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`license`): [937e8ea6d28e](#license-text-937e8ea6d28e)

### retry 0.12.0

- License: MIT
- URL: https://github.com/tim-kos/node-retry
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`License`): [1418710b026f](#license-text-1418710b026f)

### retry 0.13.1

- License: MIT
- URL: https://github.com/tim-kos/node-retry
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`License`): [1418710b026f](#license-text-1418710b026f)

### robust-predicates 3.0.3

- License: Unlicense
- URL: https://github.com/mourner/robust-predicates
- Shipped by: sedes
- License text (`LICENSE`): [79d0fc447160](#license-text-79d0fc447160)

### roughjs 4.6.6

- License: MIT
- URL: https://github.com/pshihn/rough
- Shipped by: sedes
- License text (`LICENSE`): [bb62e07404e8](#license-text-bb62e07404e8)

### router 2.2.0

- License: MIT
- URL: https://github.com/pillarjs/router
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [59ebe0cf27c4](#license-text-59ebe0cf27c4)

### rw 1.3.3

- License: BSD-3-Clause
- URL: http://github.com/mbostock/rw
- Shipped by: sedes
- License text (`LICENSE`): [1325cb60c071](#license-text-1325cb60c071)

### safe-buffer 5.2.1

- License: MIT
- URL: https://github.com/feross/safe-buffer
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [dff1a84cb703](#license-text-dff1a84cb703)

### safer-buffer 2.1.2

- License: MIT
- URL: https://github.com/ChALkeR/safer-buffer
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [aa72fb6117e4](#license-text-aa72fb6117e4)

### scheduler 0.27.0

- License: MIT
- URL: https://github.com/facebook/react/tree/HEAD/packages/scheduler
- Shipped by: sedes
- License text (`LICENSE`): [cf9b17822d1f](#license-text-cf9b17822d1f)

### semver 7.8.5

- License: ISC
- URL: https://github.com/npm/node-semver
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [0ae52fe329cc](#license-text-0ae52fe329cc)

### send 1.2.1

- License: MIT
- URL: https://github.com/pillarjs/send
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [f4b733956caa](#license-text-f4b733956caa)

### serve-static 2.2.1

- License: MIT
- URL: https://github.com/expressjs/serve-static
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [d80ea12109c5](#license-text-d80ea12109c5)

### setprototypeof 1.2.0

- License: ISC
- URL: https://github.com/wesleytodd/setprototypeof
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [db05b3b0f72f](#license-text-db05b3b0f72f)

### shebang-command 2.0.0

- License: MIT
- URL: https://github.com/kevva/shebang-command
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`license`): [1407925f6128](#license-text-1407925f6128)

### shebang-regex 3.0.0

- License: MIT
- URL: https://github.com/sindresorhus/shebang-regex
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`license`): [c9808a775260](#license-text-c9808a775260)

### shiki 4.4.2

- License: MIT
- URL: https://github.com/shikijs/shiki/tree/HEAD/packages/shiki
- Shipped by: sedes
- License text (`LICENSE`): [f20e2ee5da6c](#license-text-f20e2ee5da6c)

### side-channel 1.1.1

- License: MIT
- URL: https://github.com/ljharb/side-channel
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [7ae85337f549](#license-text-7ae85337f549)

### side-channel-list 1.0.1

- License: MIT
- URL: https://github.com/ljharb/side-channel-list
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [3df72862fb6d](#license-text-3df72862fb6d)

### side-channel-map 1.0.1

- License: MIT
- URL: https://github.com/ljharb/side-channel-map
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [3df72862fb6d](#license-text-3df72862fb6d)

### side-channel-weakmap 1.0.2

- License: MIT
- URL: https://github.com/ljharb/side-channel-weakmap
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [7ae85337f549](#license-text-7ae85337f549)

### signal-exit 3.0.7

- License: ISC
- URL: https://github.com/tapjs/signal-exit
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.txt`): [fc5c72a172de](#license-text-fc5c72a172de)

### space-separated-tokens 2.0.2

- License: MIT
- URL: https://github.com/wooorm/space-separated-tokens
- Shipped by: sedes
- License text (`license`): [d9c32f07344c](#license-text-d9c32f07344c)

### standardwebhooks 1.0.0

- License: MIT
- URL: https://github.com/standard-webhooks/standard-webhooks
- Shipped by: sedes
- License text: license text not included in package; see repository

### standardwebhooks 1.1.1

- License: MIT
- URL: https://github.com/standard-webhooks/standard-webhooks
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### statuses 2.0.2

- License: MIT
- URL: https://github.com/jshttp/statuses
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [bc11a2b203c7](#license-text-bc11a2b203c7)

### stringify-entities 4.0.4

- License: MIT
- URL: https://github.com/wooorm/stringify-entities
- Shipped by: sedes
- License text (`license`): [4be46afa7981](#license-text-4be46afa7981)

### style-to-js 1.1.21

- License: MIT
- URL: https://github.com/remarkablemark/style-to-js
- Shipped by: sedes
- License text (`LICENSE`): [bdda7d25f6d1](#license-text-bdda7d25f6d1)

### style-to-object 1.0.14

- License: MIT
- URL: https://github.com/remarkablemark/style-to-object
- Shipped by: sedes
- License text (`LICENSE`): [20b25fb4d9ba](#license-text-20b25fb4d9ba)

### stylis 4.4.0

- License: MIT
- URL: https://github.com/thysultan/stylis.js
- Shipped by: sedes
- License text (`LICENSE`): [6821b85df472](#license-text-6821b85df472)

### tailwind-merge 3.6.0

- License: MIT
- URL: https://github.com/dcastil/tailwind-merge
- Shipped by: sedes
- License text (`LICENSE.md`): [b25c1d68b353](#license-text-b25c1d68b353)

### tinyexec 1.2.4

- License: MIT
- URL: https://github.com/tinylibs/tinyexec
- Shipped by: sedes
- License text (`LICENSE`): [1b5f37fd06c1](#license-text-1b5f37fd06c1)

### toidentifier 1.0.1

- License: MIT
- URL: https://github.com/component/toidentifier
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [8d512baec1ac](#license-text-8d512baec1ac)

### trim-lines 3.0.1

- License: MIT
- URL: https://github.com/wooorm/trim-lines
- Shipped by: sedes
- License text (`license`): [4be46afa7981](#license-text-4be46afa7981)

### trough 2.2.0

- License: MIT
- URL: https://github.com/wooorm/trough
- Shipped by: sedes
- License text (`license`): [e1da326aaf68](#license-text-e1da326aaf68)

### ts-algebra 2.0.0

- License: MIT
- URL: https://github.com/ThomasAribart/ts-algebra
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [3d1a950648d8](#license-text-3d1a950648d8)

### ts-dedent 2.3.0

- License: MIT
- URL: https://github.com/tamino-martinius/node-ts-dedent
- Shipped by: sedes
- License text (`LICENSE`): [1078bbb5b87d](#license-text-1078bbb5b87d)

### tslib 2.8.1

- License: 0BSD
- URL: https://github.com/Microsoft/tslib
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE.txt`): [0e8d2550baea](#license-text-0e8d2550baea)

### type-is 2.1.0

- License: MIT
- URL: https://github.com/jshttp/type-is
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [7cb4d976f1c8](#license-text-7cb4d976f1c8)

### typebox 1.3.27

- License: MIT
- URL: https://github.com/sinclairzx81/typebox
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`license`): [e8a7cc256941](#license-text-e8a7cc256941)

### typebox 1.3.7

- License: MIT
- URL: https://github.com/sinclairzx81/typebox
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`license`): [e8a7cc256941](#license-text-e8a7cc256941)

### undici 8.10.2

- License: MIT
- URL: https://github.com/nodejs/undici
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [fe64958bfaef](#license-text-fe64958bfaef)

### undici-types 6.21.0

- License: MIT
- URL: https://github.com/nodejs/undici
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [fe64958bfaef](#license-text-fe64958bfaef)

### undici-types 8.3.0

- License: MIT
- URL: https://github.com/nodejs/undici
- Shipped by: sedes
- License text (`LICENSE`): [fe64958bfaef](#license-text-fe64958bfaef)

### undici-types 8.9.0

- License: MIT
- URL: not declared in package metadata
- Shipped by: @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text: license text not included in package; see repository

### unified 11.0.5

- License: MIT
- URL: https://github.com/unifiedjs/unified
- Shipped by: sedes
- License text (`license`): [e453dafb35c9](#license-text-e453dafb35c9)

### unist-util-is 6.0.1

- License: MIT
- URL: https://github.com/syntax-tree/unist-util-is
- Shipped by: sedes
- License text (`license`): [a1563f431b1f](#license-text-a1563f431b1f)

### unist-util-position 5.0.0

- License: MIT
- URL: https://github.com/syntax-tree/unist-util-position
- Shipped by: sedes
- License text (`license`): [c37a32dd1cd4](#license-text-c37a32dd1cd4)

### unist-util-stringify-position 4.0.0

- License: MIT
- URL: https://github.com/syntax-tree/unist-util-stringify-position
- Shipped by: sedes
- License text (`license`): [d9c32f07344c](#license-text-d9c32f07344c)

### unist-util-visit 5.1.0

- License: MIT
- URL: https://github.com/syntax-tree/unist-util-visit
- Shipped by: sedes
- License text (`license`): [c37a32dd1cd4](#license-text-c37a32dd1cd4)

### unist-util-visit-parents 6.0.2

- License: MIT
- URL: https://github.com/syntax-tree/unist-util-visit-parents
- Shipped by: sedes
- License text (`license`): [d9c32f07344c](#license-text-d9c32f07344c)

### unpipe 1.0.0

- License: MIT
- URL: https://github.com/stream-utils/unpipe
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [072fb4ea37f0](#license-text-072fb4ea37f0)

### use-callback-ref 1.3.3

- License: MIT
- URL: https://github.com/theKashey/use-callback-ref/
- Shipped by: sedes
- License text (`LICENSE`): [07dfb46d2e36](#license-text-07dfb46d2e36)

### use-sidecar 1.1.3

- License: MIT
- URL: https://github.com/theKashey/use-sidecar
- Shipped by: sedes
- License text (`LICENSE`): [07dfb46d2e36](#license-text-07dfb46d2e36)

### uuid 14.0.1

- License: MIT
- URL: https://github.com/uuidjs/uuid
- Shipped by: sedes
- License text (`LICENSE.md`): [19f9e00b8c98](#license-text-19f9e00b8c98)

### vary 1.1.2

- License: MIT
- URL: https://github.com/jshttp/vary
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [0696190d4967](#license-text-0696190d4967)

### vfile 6.0.3

- License: MIT
- URL: https://github.com/vfile/vfile
- Shipped by: sedes
- License text (`license`): [e453dafb35c9](#license-text-e453dafb35c9)

### vfile-message 4.0.3

- License: MIT
- URL: https://github.com/vfile/vfile-message
- Shipped by: sedes
- License text (`license`): [ea559213e0e9](#license-text-ea559213e0e9)

### web-streams-polyfill 3.3.3

- License: MIT
- URL: https://github.com/MattiasBuelens/web-streams-polyfill
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [fda0e18e4dc7](#license-text-fda0e18e4dc7)

### which 2.0.2

- License: ISC
- URL: https://github.com/isaacs/node-which
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [0ae52fe329cc](#license-text-0ae52fe329cc)

### wrappy 1.0.2

- License: ISC
- URL: https://github.com/npm/wrappy
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [0ae52fe329cc](#license-text-0ae52fe329cc)

### ws 8.21.0

- License: MIT
- URL: https://github.com/websockets/ws
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [7adebaeee45b](#license-text-7adebaeee45b)

### ws 8.21.1

- License: MIT
- URL: https://github.com/websockets/ws
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [7adebaeee45b](#license-text-7adebaeee45b)

### yaml 2.9.0

- License: ISC
- URL: https://github.com/eemeli/yaml
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [cf12d35c36ba](#license-text-cf12d35c36ba)

### zod 4.4.3

- License: MIT
- URL: https://github.com/colinhacks/zod
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [f61cacc2acb8](#license-text-f61cacc2acb8)

### zod-to-json-schema 3.25.2

- License: ISC
- URL: https://github.com/StefanTerdell/zod-to-json-schema
- Shipped by: sedes, @sedes/electron-local-server-runtime, @sedes/server-runtime
- License text (`LICENSE`): [80d3168ad2f7](#license-text-80d3168ad2f7)

### zwitch 2.0.4

- License: MIT
- URL: https://github.com/wooorm/zwitch
- Shipped by: sedes
- License text (`license`): [d9c32f07344c](#license-text-d9c32f07344c)

## License texts

Each license text below is stored once and keyed by the first
12 hexadecimal characters of the SHA-256 digest of its normalized
text (CRLF normalized to LF, trailing whitespace removed). Package entries
above reference the text that applies to them.

### License text 006a2e42087f

Applies to: get-intrinsic 1.3.0.

```text
MIT License

Copyright (c) 2020 Jordan Harband

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 0139f2c14d4e

Applies to: bowser 2.14.1.

```text
Copyright 2015, Dustin Diaz (the "Original Author")
All rights reserved.

MIT License

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

Distributions of all or part of the Software intended to be used
by the recipients as they would use the unmodified Software,
containing modifications that substantially alter, remove, or
disable functionality of the Software, outside of the documented
configuration mechanisms provided by the Software, shall be
modified such that the Original Author's bug reporting email
addresses and urls are either replaced with the contact information
of the parties responsible for the changes, or removed entirely.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.


Except where noted, this license applies to any and all software
programs and associated documentation files created by the
Original Author, when distributed with the Software.
```

### License text 02d42589c644

Applies to: ip-address 10.4.0.

```text
Copyright (C) 2011 by Beau Gunderson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text 02f3b7dba54e

Applies to: es-toolkit 1.50.0.

```text
MIT License

Copyright (c) 2024 Viva Republica, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 045ce74712fc

Applies to: @iconify/types 2.0.0.

```text
MIT License

Copyright (c) 2021 - 2022 Vjacheslav Trushkin / Iconify OÜ

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 05a601c405df

Applies to: points-on-path 0.2.1.

```text
MIT License

Copyright (c) 2020 Preet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 0696190d4967

Applies to: content-disposition 1.1.0, forwarded 0.2.0, media-typer 1.1.1, vary 1.1.2.

```text
(The MIT License)

Copyright (c) 2014-2017 Douglas Christopher Wilson

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 072fb4ea37f0

Applies to: unpipe 1.0.0.

```text
(The MIT License)

Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 07dfb46d2e36

Applies to: aria-hidden 1.2.6, react-remove-scroll 2.7.2, react-style-singleton 2.2.3, use-callback-ref 1.3.3, use-sidecar 1.1.3.

```text
MIT License

Copyright (c) 2017 Anton Korzunov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 0ae52fe329cc

Applies to: isexe 2.0.0, once 1.4.0, semver 7.8.5, which 2.0.2, wrappy 1.0.2.

```text
The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### License text 0bc46fcdad09

Applies to: @braintree/sanitize-url 7.1.2.

```text
MIT License

Copyright (c) 2017 Braintree

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 0e8d2550baea

Applies to: tslib 2.8.1.

```text
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### License text 0e99f2710dd2

Applies to: estree-util-is-identifier-name 3.0.0, mdast-util-gfm-autolink-literal 2.0.1, mdast-util-gfm-strikethrough 2.0.0, mdast-util-gfm-table 2.0.0, mdast-util-gfm-task-list-item 2.0.0, mdast-util-mdx-expression 2.0.1, mdast-util-mdx-jsx 3.2.0, mdast-util-mdxjs-esm 2.0.1, micromark-extension-gfm 3.0.0, micromark-extension-gfm-autolink-literal 2.1.0, micromark-extension-gfm-strikethrough 2.1.0, micromark-extension-gfm-tagfilter 2.0.0, micromark-extension-gfm-task-list-item 2.1.0.

```text
(The MIT License)

Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 0eb7e0538bf8

Applies to: ajv-formats 3.0.1.

```text
MIT License

Copyright (c) 2020 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 1078bbb5b87d

Applies to: ts-dedent 2.3.0.

```text
MIT License

Copyright (c) 2018 Tamino Martinius

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 1325cb60c071

Applies to: rw 1.3.3.

```text
Copyright (c) 2014-2016, Michael Bostock
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* The name Michael Bostock may not be used to endorse or promote products
  derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL MICHAEL BOSTOCK BE LIABLE FOR ANY DIRECT,
INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text 1407925f6128

Applies to: shebang-command 2.0.0.

```text
MIT License

Copyright (c) Kevin Mårtensson <kevinmartensson@gmail.com> (github.com/kevva)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 1418710b026f

Applies to: retry 0.12.0, retry 0.13.1.

```text
Copyright (c) 2011:
Tim Koschützki (tim@debuggable.com)
Felix Geisendörfer (felix@debuggable.com)

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
```

### License text 14d069c68fe7

Applies to: qs 6.15.3.

```text
BSD 3-Clause License

Copyright (c) 2014, Nathan LaFreniere and other [contributors](https://github.com/ljharb/qs/graphs/contributors)
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text 1521adecf617

Applies to: dagre-d3-es 7.0.14.

```text
Original dagre-d3 copyright: Copyright (c) 2013 Chris Pettitt
Original dagre copyright: Copyright (c) 2012-2014 Chris Pettitt
Original graphlib copyright: Copyright (c) 2012-2014 Chris Pettitt

Copyright (c) 2022-2024 Thibaut Lassalle, David Newell, Alois Klink, Sidharth Vinod and dagre-es contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text 1529f88b3675

Applies to: chalk 6.0.0, escape-string-regexp 5.0.0, get-east-asian-width 1.6.0, is-plain-obj 4.1.0.

```text
MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 1549638d9e45

Applies to: d3-scale-chromatic 3.1.0.

```text
Copyright 2010-2024 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.

Apache-Style Software License for ColorBrewer software and ColorBrewer Color Schemes

Copyright 2002 Cynthia Brewer, Mark Harrower, and The Pennsylvania State University

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.
```

### License text 16e34a46fa58

Applies to: dayjs 1.11.21.

```text
MIT License

Copyright (c) 2018-present, iamkun

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 189cbd7c4b22

Applies to: devlop 1.1.0.

```text
(The MIT License)

Copyright (c) 2023 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 19f9e00b8c98

Applies to: uuid 14.0.1.

```text
The MIT License (MIT)

Copyright (c) 2010-2020 Robert Kieffer and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 1a9975c75cfc

Applies to: lru-cache 11.4.0.

```text
# Blue Oak Model License

Version 1.0.0

## Purpose

This license gives everyone as much permission to work with
this software as possible, while protecting contributors
from liability.

## Acceptance

In order to receive this license, you must agree to its
rules.  The rules of this license are both obligations
under that agreement and conditions to your license.
You must not do anything with this software that triggers
a rule that you cannot or will not follow.

## Copyright

Each contributor licenses you to do everything with this
software that would otherwise infringe that contributor's
copyright in it.

## Notices

You must ensure that everyone who gets a copy of
any part of this software from you, with or without
changes, also gets the text of this license or a link to
<https://blueoakcouncil.org/license/1.0.0>.

## Excuse

If anyone notifies you in writing that you have not
complied with [Notices](#notices), you can keep your
license by taking all practical steps to comply within 30
days after the notice.  If you do not do so, your license
ends immediately.

## Patent

Each contributor licenses you to do everything with this
software that would otherwise infringe any patent claims
they can license or become able to license.

## Reliability

No contributor can revoke this license.

## No Liability

***As far as the law allows, this software comes as is,
without any warranty or condition, and no contributor
will be liable to anyone for any damages related to this
software or this license, under any kind of legal claim.***
```

### License text 1b5f37fd06c1

Applies to: tinyexec 1.2.4.

```text
MIT License

Copyright (c) 2024 Tinylibs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 1d660eff8965

Applies to: node-addon-api 7.1.1, node-addon-api 8.9.0.

```text
The MIT License (MIT)

Copyright (c) 2017 [Node.js API collaborators](https://github.com/nodejs/node-addon-api#collaborators)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 20b25fb4d9ba

Applies to: style-to-object 1.0.14.

```text
The MIT License (MIT)

Copyright (c) 2017 Menglin "Mark" Xu <mark@remarkablemark.org>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 21406f0433c8

Applies to: express-rate-limit 8.6.1.

```text
# MIT License

Copyright 2023 Nathan Friedly, Vedant K

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 22fc2b0e60ba

Applies to: @ungap/structured-clone 1.3.3.

```text
ISC License

Copyright (c) 2021, Andrea Giammarchi, @WebReflection

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### License text 2314aa0e2bae

Applies to: lodash-es 4.18.1.

```text
Copyright OpenJS Foundation and other contributors <https://openjsf.org/>

Based on Underscore.js, copyright Jeremy Ashkenas,
DocumentCloud and Investigative Reporters & Editors <http://underscorejs.org/>

This software consists of voluntary contributions made by many
individuals. For exact contribution history, see the revision history
available at https://github.com/lodash/lodash

The following license applies to all parts of this software except as
documented below:

====

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

====

Copyright and related rights for sample code are waived via CC0. Sample
code is defined as all source code displayed within the prose of the
documentation.

CC0: http://creativecommons.org/publicdomain/zero/1.0/

====

Files located in the node_modules and vendor directories are externally
maintained libraries used by this software which have their own
licenses; we recommend you read them, as their terms may differ from the
terms above.
```

### License text 23b57495a1f9

Applies to: balanced-match 4.0.4.

```text
(MIT)

Original code Copyright Julian Gruber <julian@juliangruber.com>

Port to TypeScript Copyright Isaac Z. Schlueter <i@izs.me>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 283ea6cc2997

Applies to: @chevrotain/types 11.1.2, @google/genai 2.21.0, dompurify 3.4.13, gaxios 7.1.4, gaxios 7.3.1, gcp-metadata 8.1.2, google-auth-library 10.6.2, google-auth-library 10.9.1, google-logging-utils 1.1.3, long 5.3.2.

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text 2bc4beb49d48

Applies to: object-assign 4.1.1.

```text
The MIT License (MIT)

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text 2c44cee9bf9d

Applies to: buffer-equal-constant-time 1.0.1.

```text
Copyright (c) 2013, GoInstant Inc., a salesforce.com company
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

* Neither the name of salesforce.com, nor GoInstant, nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text 2c5fce57341d

Applies to: delaunator 5.1.0.

```text
ISC License

Copyright (c) 2026, Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text 2cf2d507c76c

Applies to: html-url-attributes 3.0.1.

```text
(The MIT License)

Copyright (c) Titus Wormer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text 2e0a854a1106

Applies to: hono 4.12.32.

```text
MIT License

Copyright (c) 2021 - present, Yusuke Wada and Hono contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 2ef1e48ea743

Applies to: @aws-sdk/credential-provider-process 3.972.70, @aws-sdk/credential-provider-process 3.972.71, @aws-sdk/credential-provider-sso 3.973.14, @aws-sdk/credential-provider-sso 3.973.15, @aws-sdk/credential-provider-web-identity 3.972.76, @aws-sdk/credential-provider-web-identity 3.972.77, @aws-sdk/eventstream-handler-node 3.972.34, @aws-sdk/middleware-websocket 3.972.52, @aws-sdk/middleware-websocket 3.972.53, @aws-sdk/signature-v4-multi-region 3.996.46, @smithy/core 3.33.3, @smithy/core 3.34.1, @smithy/types 4.18.0.

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text 2f09b31fcc47

Applies to: @pierre/diffs 1.3.4, @pierre/theme 2.0.0, @pierre/theming 1.0.0, @pierre/theming 1.0.1, @pierre/trees 1.0.0-beta.6.

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1.  Definitions.

    "License" shall mean the terms and conditions for use, reproduction, and
    distribution as defined by Sections 1 through 9 of this document.

    "Licensor" shall mean the copyright owner or entity authorized by the
    copyright owner that is granting the License.

    "Legal Entity" shall mean the union of the acting entity and all other
    entities that control, are controlled by, or are under common control with
    that entity. For the purposes of this definition, "control" means (i) the
    power, direct or indirect, to cause the direction or management of such
    entity, whether by contract or otherwise, or (ii) ownership of fifty percent
    (50%) or more of the outstanding shares, or (iii) beneficial ownership of
    such entity.

    "You" (or "Your") shall mean an individual or Legal Entity exercising
    permissions granted by this License.

    "Source" form shall mean the preferred form for making modifications,
    including but not limited to software source code, documentation source, and
    configuration files.

    "Object" form shall mean any form resulting from mechanical transformation
    or translation of a Source form, including but not limited to compiled
    object code, generated documentation, and conversions to other media types.

    "Work" shall mean the work of authorship, whether in Source or Object form,
    made available under the License, as indicated by a copyright notice that is
    included in or attached to the work (an example is provided in the Appendix
    below).

    "Derivative Works" shall mean any work, whether in Source or Object form,
    that is based on (or derived from) the Work and for which the editorial
    revisions, annotations, elaborations, or other modifications represent, as a
    whole, an original work of authorship. For the purposes of this License,
    Derivative Works shall not include works that remain separable from, or
    merely link (or bind by name) to the interfaces of, the Work and Derivative
    Works thereof.

    "Contribution" shall mean any work of authorship, including the original
    version of the Work and any modifications or additions to that Work or
    Derivative Works thereof, that is intentionally submitted to Licensor for
    inclusion in the Work by the copyright owner or by an individual or Legal
    Entity authorized to submit on behalf of the copyright owner. For the
    purposes of this definition, "submitted" means any form of electronic,
    verbal, or written communication sent to the Licensor or its
    representatives, including but not limited to communication on electronic
    mailing lists, source code control systems, and issue tracking systems that
    are managed by, or on behalf of, the Licensor for the purpose of discussing
    and improving the Work, but excluding communication that is conspicuously
    marked or otherwise designated in writing by the copyright owner as "Not a
    Contribution."

    "Contributor" shall mean Licensor and any individual or Legal Entity on
    behalf of whom a Contribution has been received by Licensor and subsequently
    incorporated within the Work.

2.  Grant of Copyright License. Subject to the terms and conditions of this
    License, each Contributor hereby grants to You a perpetual, worldwide,
    non-exclusive, no-charge, royalty-free, irrevocable copyright license to
    reproduce, prepare Derivative Works of, publicly display, publicly perform,
    sublicense, and distribute the Work and such Derivative Works in Source or
    Object form.

3.  Grant of Patent License. Subject to the terms and conditions of this
    License, each Contributor hereby grants to You a perpetual, worldwide,
    non-exclusive, no-charge, royalty-free, irrevocable (except as stated in
    this section) patent license to make, have made, use, offer to sell, sell,
    import, and otherwise transfer the Work, where such license applies only to
    those patent claims licensable by such Contributor that are necessarily
    infringed by their Contribution(s) alone or by combination of their
    Contribution(s) with the Work to which such Contribution(s) was submitted.
    If You institute patent litigation against any entity (including a
    cross-claim or counterclaim in a lawsuit) alleging that the Work or a
    Contribution incorporated within the Work constitutes direct or contributory
    patent infringement, then any patent licenses granted to You under this
    License for that Work shall terminate as of the date such litigation is
    filed.

4.  Redistribution. You may reproduce and distribute copies of the Work or
    Derivative Works thereof in any medium, with or without modifications, and
    in Source or Object form, provided that You meet the following conditions:

    (a) You must give any other recipients of the Work or Derivative Works a
    copy of this License; and

    (b) You must cause any modified files to carry prominent notices stating
    that You changed the files; and

    (c) You must retain, in the Source form of any Derivative Works that You
    distribute, all copyright, patent, trademark, and attribution notices from
    the Source form of the Work, excluding those notices that do not pertain to
    any part of the Derivative Works; and

    (d) If the Work includes a "NOTICE" text file as part of its distribution,
    then any Derivative Works that You distribute must include a readable copy
    of the attribution notices contained within such NOTICE file, excluding
    those notices that do not pertain to any part of the Derivative Works, in at
    least one of the following places: within a NOTICE text file distributed as
    part of the Derivative Works; within the Source form or documentation, if
    provided along with the Derivative Works; or, within a display generated by
    the Derivative Works, if and wherever such third-party notices normally
    appear. The contents of the NOTICE file are for informational purposes only
    and do not modify the License. You may add Your own attribution notices
    within Derivative Works that You distribute, alongside or as an addendum to
    the NOTICE text from the Work, provided that such additional attribution
    notices cannot be construed as modifying the License.

    You may add Your own copyright statement to Your modifications and may
    provide additional or different license terms and conditions for use,
    reproduction, or distribution of Your modifications, or for any such
    Derivative Works as a whole, provided Your use, reproduction, and
    distribution of the Work otherwise complies with the conditions stated in
    this License.

5.  Submission of Contributions. Unless You explicitly state otherwise, any
    Contribution intentionally submitted for inclusion in the Work by You to the
    Licensor shall be under the terms and conditions of this License, without
    any additional terms or conditions. Notwithstanding the above, nothing
    herein shall supersede or modify the terms of any separate license agreement
    you may have executed with Licensor regarding such Contributions.

6.  Trademarks. This License does not grant permission to use the trade names,
    trademarks, service marks, or product names of the Licensor, except as
    required for reasonable and customary use in describing the origin of the
    Work and reproducing the content of the NOTICE file.

7.  Disclaimer of Warranty. Unless required by applicable law or agreed to in
    writing, Licensor provides the Work (and each Contributor provides its
    Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied, including, without limitation, any
    warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or
    FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining
    the appropriateness of using or redistributing the Work and assume any risks
    associated with Your exercise of permissions under this License.

8.  Limitation of Liability. In no event and under no legal theory, whether in
    tort (including negligence), contract, or otherwise, unless required by
    applicable law (such as deliberate and grossly negligent acts) or agreed to
    in writing, shall any Contributor be liable to You for damages, including
    any direct, indirect, special, incidental, or consequential damages of any
    character arising as a result of this License or out of the use or inability
    to use the Work (including but not limited to damages for loss of goodwill,
    work stoppage, computer failure or malfunction, or any and all other
    commercial damages or losses), even if such Contributor has been advised of
    the possibility of such damages.

9.  Accepting Warranty or Additional Liability. While redistributing the Work or
    Derivative Works thereof, You may choose to offer, and charge a fee for,
    acceptance of support, warranty, indemnity, or other liability obligations
    and/or rights consistent with this License. However, in accepting such
    obligations, You may act only on Your own behalf and on Your sole
    responsibility, not on behalf of any other Contributor, and only if You
    agree to indemnify, defend, and hold each Contributor harmless for any
    liability incurred by, or claims asserted against, such Contributor by
    reason of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

Copyright 2025 Pierre Computer Company

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at

       http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.
```

### License text 35d16fc259cf

Applies to: @hono/node-server 2.0.12.

```text
MIT License

Copyright (c) 2022 - present, Yusuke Wada and Hono contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 38fdb5e42d48

Applies to: d3-sankey 0.12.3.

```text
Copyright 2015, Mike Bostock
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the author nor the names of contributors may be used to
  endorse or promote products derived from this software without specific prior
  written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text 396681618aa8

Applies to: import-meta-resolve 4.2.0.

```text
(The MIT License)

Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

This is a derivative work based on:
<https://github.com/nodejs/node>.
Which is licensed:

"""
Copyright Node.js contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
"""

This license applies to parts of Node.js originating from the
https://github.com/joyent/node repository:

"""
Copyright Joyent, Inc. and other Node contributors. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
"""
```

### License text 39813fa23b19

Applies to: eventsource-parser 3.1.0.

```text
MIT License

Copyright (c) 2026 Espen Hovlandsdal <espen@hovlandsdal.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 399cbcc4b8a2

Applies to: node-fetch 3.3.2.

```text
The MIT License (MIT)

Copyright (c) 2016 - 2020 Node Fetch Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 39b03b27e43a

Applies to: cytoscape-cose-bilkent 4.1.0.

```text
Copyright (c) 2016-2018, The Cytoscape Consortium.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the “Software”), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 3a395674c5c9

Applies to: inherits 2.0.4.

```text
The ISC License

Copyright (c) Isaac Z. Schlueter

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### License text 3d1a950648d8

Applies to: json-schema-to-ts 3.1.1, ts-algebra 2.0.0.

```text
MIT License

Copyright (c) 2020 Thomas Aribart

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 3d5b63706380

Applies to: clsx 2.1.1.

```text
MIT License

Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 3df72862fb6d

Applies to: call-bind-apply-helpers 1.0.2, call-bound 1.0.4, es-define-property 1.0.1, es-errors 1.3.0, es-object-atoms 1.1.2, side-channel-list 1.0.1, side-channel-map 1.0.1.

```text
MIT License

Copyright (c) 2024 Jordan Harband

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 3f7cd27a6e50

Applies to: gopd 1.2.0.

```text
MIT License

Copyright (c) 2022 Jordan Harband

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 42fbee6b9cc2

Applies to: dunder-proto 1.0.1, math-intrinsics 1.1.0.

```text
MIT License

Copyright (c) 2024 ECMAScript Shims

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 44191656d296

Applies to: is-promise 4.0.0.

```text
Copyright (c) 2014 Forbes Lindesay

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text 48186f5950f2

Applies to: iconv-lite 0.6.3, iconv-lite 0.7.3.

```text
Copyright (c) 2011 Alexander Shtuchkin

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 490ab72226a2

Applies to: better-sqlite3 13.0.2.

```text
The MIT License (MIT)

Copyright (c) 2017 Joshua Wise

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 49fa72ab1de5

Applies to: etag 1.8.1, proxy-addr 2.0.7.

```text
(The MIT License)

Copyright (c) 2014-2016 Douglas Christopher Wilson

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 4b2513f280f3

Applies to: d3-path 1.0.9.

```text
Copyright 2015-2016 Mike Bostock
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the author nor the names of contributors may be used to
  endorse or promote products derived from this software without specific prior
  written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text 4b47df8ec858

Applies to: regex-utilities 2.3.0.

```text
MIT License

Copyright (c) 2024 Steven Levithan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 4b89d4518bd1

Applies to: dompurify 3.4.13.

```text
Mozilla Public License Version 2.0
==================================

1. Definitions
--------------

1.1. "Contributor"
    means each individual or legal entity that creates, contributes to
    the creation of, or owns Covered Software.

1.2. "Contributor Version"
    means the combination of the Contributions of others (if any) used
    by a Contributor and that particular Contributor's Contribution.

1.3. "Contribution"
    means Covered Software of a particular Contributor.

1.4. "Covered Software"
    means Source Code Form to which the initial Contributor has attached
    the notice in Exhibit A, the Executable Form of such Source Code
    Form, and Modifications of such Source Code Form, in each case
    including portions thereof.

1.5. "Incompatible With Secondary Licenses"
    means

    (a) that the initial Contributor has attached the notice described
        in Exhibit B to the Covered Software; or

    (b) that the Covered Software was made available under the terms of
        version 1.1 or earlier of the License, but not also under the
        terms of a Secondary License.

1.6. "Executable Form"
    means any form of the work other than Source Code Form.

1.7. "Larger Work"
    means a work that combines Covered Software with other material, in
    a separate file or files, that is not Covered Software.

1.8. "License"
    means this document.

1.9. "Licensable"
    means having the right to grant, to the maximum extent possible,
    whether at the time of the initial grant or subsequently, any and
    all of the rights conveyed by this License.

1.10. "Modifications"
    means any of the following:

    (a) any file in Source Code Form that results from an addition to,
        deletion from, or modification of the contents of Covered
        Software; or

    (b) any new file in Source Code Form that contains any Covered
        Software.

1.11. "Patent Claims" of a Contributor
    means any patent claim(s), including without limitation, method,
    process, and apparatus claims, in any patent Licensable by such
    Contributor that would be infringed, but for the grant of the
    License, by the making, using, selling, offering for sale, having
    made, import, or transfer of either its Contributions or its
    Contributor Version.

1.12. "Secondary License"
    means either the GNU General Public License, Version 2.0, the GNU
    Lesser General Public License, Version 2.1, the GNU Affero General
    Public License, Version 3.0, or any later versions of those
    licenses.

1.13. "Source Code Form"
    means the form of the work preferred for making modifications.

1.14. "You" (or "Your")
    means an individual or a legal entity exercising rights under this
    License. For legal entities, "You" includes any entity that
    controls, is controlled by, or is under common control with You. For
    purposes of this definition, "control" means (a) the power, direct
    or indirect, to cause the direction or management of such entity,
    whether by contract or otherwise, or (b) ownership of more than
    fifty percent (50%) of the outstanding shares or beneficial
    ownership of such entity.

2. License Grants and Conditions
--------------------------------

2.1. Grants

Each Contributor hereby grants You a world-wide, royalty-free,
non-exclusive license:

(a) under intellectual property rights (other than patent or trademark)
    Licensable by such Contributor to use, reproduce, make available,
    modify, display, perform, distribute, and otherwise exploit its
    Contributions, either on an unmodified basis, with Modifications, or
    as part of a Larger Work; and

(b) under Patent Claims of such Contributor to make, use, sell, offer
    for sale, have made, import, and otherwise transfer either its
    Contributions or its Contributor Version.

2.2. Effective Date

The licenses granted in Section 2.1 with respect to any Contribution
become effective for each Contribution on the date the Contributor first
distributes such Contribution.

2.3. Limitations on Grant Scope

The licenses granted in this Section 2 are the only rights granted under
this License. No additional rights or licenses will be implied from the
distribution or licensing of Covered Software under this License.
Notwithstanding Section 2.1(b) above, no patent license is granted by a
Contributor:

(a) for any code that a Contributor has removed from Covered Software;
    or

(b) for infringements caused by: (i) Your and any other third party's
    modifications of Covered Software, or (ii) the combination of its
    Contributions with other software (except as part of its Contributor
    Version); or

(c) under Patent Claims infringed by Covered Software in the absence of
    its Contributions.

This License does not grant any rights in the trademarks, service marks,
or logos of any Contributor (except as may be necessary to comply with
the notice requirements in Section 3.4).

2.4. Subsequent Licenses

No Contributor makes additional grants as a result of Your choice to
distribute the Covered Software under a subsequent version of this
License (see Section 10.2) or under the terms of a Secondary License (if
permitted under the terms of Section 3.3).

2.5. Representation

Each Contributor represents that the Contributor believes its
Contributions are its original creation(s) or it has sufficient rights
to grant the rights to its Contributions conveyed by this License.

2.6. Fair Use

This License is not intended to limit any rights You have under
applicable copyright doctrines of fair use, fair dealing, or other
equivalents.

2.7. Conditions

Sections 3.1, 3.2, 3.3, and 3.4 are conditions of the licenses granted
in Section 2.1.

3. Responsibilities
-------------------

3.1. Distribution of Source Form

All distribution of Covered Software in Source Code Form, including any
Modifications that You create or to which You contribute, must be under
the terms of this License. You must inform recipients that the Source
Code Form of the Covered Software is governed by the terms of this
License, and how they can obtain a copy of this License. You may not
attempt to alter or restrict the recipients' rights in the Source Code
Form.

3.2. Distribution of Executable Form

If You distribute Covered Software in Executable Form then:

(a) such Covered Software must also be made available in Source Code
    Form, as described in Section 3.1, and You must inform recipients of
    the Executable Form how they can obtain a copy of such Source Code
    Form by reasonable means in a timely manner, at a charge no more
    than the cost of distribution to the recipient; and

(b) You may distribute such Executable Form under the terms of this
    License, or sublicense it under different terms, provided that the
    license for the Executable Form does not attempt to limit or alter
    the recipients' rights in the Source Code Form under this License.

3.3. Distribution of a Larger Work

You may create and distribute a Larger Work under terms of Your choice,
provided that You also comply with the requirements of this License for
the Covered Software. If the Larger Work is a combination of Covered
Software with a work governed by one or more Secondary Licenses, and the
Covered Software is not Incompatible With Secondary Licenses, this
License permits You to additionally distribute such Covered Software
under the terms of such Secondary License(s), so that the recipient of
the Larger Work may, at their option, further distribute the Covered
Software under the terms of either this License or such Secondary
License(s).

3.4. Notices

You may not remove or alter the substance of any license notices
(including copyright notices, patent notices, disclaimers of warranty,
or limitations of liability) contained within the Source Code Form of
the Covered Software, except that You may alter any license notices to
the extent required to remedy known factual inaccuracies.

3.5. Application of Additional Terms

You may choose to offer, and to charge a fee for, warranty, support,
indemnity or liability obligations to one or more recipients of Covered
Software. However, You may do so only on Your own behalf, and not on
behalf of any Contributor. You must make it absolutely clear that any
such warranty, support, indemnity, or liability obligation is offered by
You alone, and You hereby agree to indemnify every Contributor for any
liability incurred by such Contributor as a result of warranty, support,
indemnity or liability terms You offer. You may include additional
disclaimers of warranty and limitations of liability specific to any
jurisdiction.

4. Inability to Comply Due to Statute or Regulation
---------------------------------------------------

If it is impossible for You to comply with any of the terms of this
License with respect to some or all of the Covered Software due to
statute, judicial order, or regulation then You must: (a) comply with
the terms of this License to the maximum extent possible; and (b)
describe the limitations and the code they affect. Such description must
be placed in a text file included with all distributions of the Covered
Software under this License. Except to the extent prohibited by statute
or regulation, such description must be sufficiently detailed for a
recipient of ordinary skill to be able to understand it.

5. Termination
--------------

5.1. The rights granted under this License will terminate automatically
if You fail to comply with any of its terms. However, if You become
compliant, then the rights granted under this License from a particular
Contributor are reinstated (a) provisionally, unless and until such
Contributor explicitly and finally terminates Your grants, and (b) on an
ongoing basis, if such Contributor fails to notify You of the
non-compliance by some reasonable means prior to 60 days after You have
come back into compliance. Moreover, Your grants from a particular
Contributor are reinstated on an ongoing basis if such Contributor
notifies You of the non-compliance by some reasonable means, this is the
first time You have received notice of non-compliance with this License
from such Contributor, and You become compliant prior to 30 days after
Your receipt of the notice.

5.2. If You initiate litigation against any entity by asserting a patent
infringement claim (excluding declaratory judgment actions,
counter-claims, and cross-claims) alleging that a Contributor Version
directly or indirectly infringes any patent, then the rights granted to
You by any and all Contributors for the Covered Software under Section
2.1 of this License shall terminate.

5.3. In the event of termination under Sections 5.1 or 5.2 above, all
end user license agreements (excluding distributors and resellers) which
have been validly granted by You or Your distributors under this License
prior to termination shall survive termination.

************************************************************************
*                                                                      *
*  6. Disclaimer of Warranty                                           *
*  -------------------------                                           *
*                                                                      *
*  Covered Software is provided under this License on an "as is"       *
*  basis, without warranty of any kind, either expressed, implied, or  *
*  statutory, including, without limitation, warranties that the       *
*  Covered Software is free of defects, merchantable, fit for a        *
*  particular purpose or non-infringing. The entire risk as to the     *
*  quality and performance of the Covered Software is with You.        *
*  Should any Covered Software prove defective in any respect, You     *
*  (not any Contributor) assume the cost of any necessary servicing,   *
*  repair, or correction. This disclaimer of warranty constitutes an   *
*  essential part of this License. No use of any Covered Software is   *
*  authorized under this License except under this disclaimer.         *
*                                                                      *
************************************************************************

************************************************************************
*                                                                      *
*  7. Limitation of Liability                                          *
*  --------------------------                                          *
*                                                                      *
*  Under no circumstances and under no legal theory, whether tort      *
*  (including negligence), contract, or otherwise, shall any           *
*  Contributor, or anyone who distributes Covered Software as          *
*  permitted above, be liable to You for any direct, indirect,         *
*  special, incidental, or consequential damages of any character      *
*  including, without limitation, damages for lost profits, loss of    *
*  goodwill, work stoppage, computer failure or malfunction, or any    *
*  and all other commercial damages or losses, even if such party      *
*  shall have been informed of the possibility of such damages. This   *
*  limitation of liability shall not apply to liability for death or   *
*  personal injury resulting from such party's negligence to the       *
*  extent applicable law prohibits such limitation. Some               *
*  jurisdictions do not allow the exclusion or limitation of           *
*  incidental or consequential damages, so this exclusion and          *
*  limitation may not apply to You.                                    *
*                                                                      *
************************************************************************

8. Litigation
-------------

Any litigation relating to this License may be brought only in the
courts of a jurisdiction where the defendant maintains its principal
place of business and such litigation shall be governed by laws of that
jurisdiction, without reference to its conflict-of-law provisions.
Nothing in this Section shall prevent a party's ability to bring
cross-claims or counter-claims.

9. Miscellaneous
----------------

This License represents the complete agreement concerning the subject
matter hereof. If any provision of this License is held to be
unenforceable, such provision shall be reformed only to the extent
necessary to make it enforceable. Any law or regulation which provides
that the language of a contract shall be construed against the drafter
shall not be used to construe this License against a Contributor.

10. Versions of the License
---------------------------

10.1. New Versions

Mozilla Foundation is the license steward. Except as provided in Section
10.3, no one other than the license steward has the right to modify or
publish new versions of this License. Each version will be given a
distinguishing version number.

10.2. Effect of New Versions

You may distribute the Covered Software under the terms of the version
of the License under which You originally received the Covered Software,
or under the terms of any subsequent version published by the license
steward.

10.3. Modified Versions

If you create software not governed by this License, and you want to
create a new license for such software, you may create and use a
modified version of this License if you rename the license and remove
any references to the name of the license steward (except to note that
such modified license differs from this License).

10.4. Distributing Source Code Form that is Incompatible With Secondary
Licenses

If You choose to distribute Source Code Form that is Incompatible With
Secondary Licenses under the terms of this version of the License, the
notice described in Exhibit B of this License must be attached.

Exhibit A - Source Code Form License Notice
-------------------------------------------

  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at http://mozilla.org/MPL/2.0/.

If it is not possible or desirable to put the notice in a particular
file, then You may include the notice in a location (such as a LICENSE
file in a relevant directory) where a recipient would be likely to look
for such a notice.

You may add additional accurate notices of copyright ownership.

Exhibit B - "Incompatible With Secondary Licenses" Notice
---------------------------------------------------------

  This Source Code Form is "Incompatible With Secondary Licenses", as
  defined by the Mozilla Public License, v. 2.0.
```

### License text 4be46afa7981

Applies to: longest-streak 3.1.0, stringify-entities 4.0.4, trim-lines 3.0.1.

```text
(The MIT License)

Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 4c1cd1d0c4f8

Applies to: d3-dsv 3.0.1.

```text
Copyright 2013-2021 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text 4cc9c2af4eb0

Applies to: commander 7.2.0, commander 8.3.0.

```text
(The MIT License)

Copyright (c) 2011 TJ Holowaychuk <tj@vision-media.ca>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 4f221aee6e07

Applies to: @noble/hashes 2.4.0.

```text
The MIT License (MIT)

Copyright (c) 2022 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text 4f4f9997e3d9

Applies to: d3-color 3.1.0, d3-shape 3.2.0, d3-time 3.1.0.

```text
Copyright 2010-2022 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text 4f8e381e74d4

Applies to: d3-delaunay 6.0.4.

```text
Copyright 2018-2021 Observable, Inc.
Copyright 2021 Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text 50366760ca85

Applies to: d3-shape 1.3.7.

```text
Copyright 2010-2015 Mike Bostock
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the author nor the names of contributors may be used to
  endorse or promote products derived from this software without specific prior
  written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text 50640bbffc17

Applies to: ecdsa-sig-formatter 1.0.11.

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2015 D2L Corporation

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text 5135f3f76071

Applies to: khroma 2.1.0.

```text
The MIT License (MIT)

Copyright (c) 2019-present Fabio Spampinato, Andrew Maney

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

### License text 56c9299ed8fb

Applies to: @protobufjs/aspromise 1.1.2, @protobufjs/base64 1.1.2, @protobufjs/codegen 2.0.5, @protobufjs/eventemitter 1.1.1, @protobufjs/fetch 1.1.1, @protobufjs/float 1.0.2, @protobufjs/path 1.1.2, @protobufjs/pool 1.1.0, @protobufjs/utf8 1.1.1, @protobufjs/utf8 1.1.2.

```text
Copyright (c) 2016, Daniel Wirtz  All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of its author, nor the names of its contributors
  may be used to endorse or promote products derived from this software
  without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text 586409690da3

Applies to: d3-array 2.12.1.

```text
Copyright 2010-2020 Mike Bostock
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the author nor the names of contributors may be used to
  endorse or promote products derived from this software without specific prior
  written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text 58f959e2911c

Applies to: d3-path 3.1.0.

```text
Copyright 2015-2022 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text 59e8b888f1d3

Applies to: micromark-extension-gfm-footnote 2.1.0.

```text
(The MIT License)

Copyright (c) 2021 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 59ebe0cf27c4

Applies to: router 2.2.0.

```text
(The MIT License)

Copyright (c) 2013 Roman Shtylman
Copyright (c) 2014-2022 Douglas Christopher Wilson

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 5dd2a43c0ed6

Applies to: detect-node-es 1.1.0.

```text
MIT License

Copyright (c) 2017 Ilya Kantor

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 5de22a7021a0

Applies to: on-finished 2.4.1.

```text
(The MIT License)

Copyright (c) 2013 Jonathan Ong <me@jongleberry.com>
Copyright (c) 2014 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 5e7b89989b94

Applies to: cross-spawn 7.0.6, proper-lockfile 4.1.2.

```text
The MIT License (MIT)

Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text 6019bf345195

Applies to: d3-axis 3.0.0, d3-brush 3.0.0, d3-chord 3.0.1, d3-dispatch 3.0.1, d3-drag 3.0.0, d3-force 3.0.0, d3-hierarchy 3.1.2, d3-interpolate 3.0.1, d3-polygon 3.0.1, d3-quadtree 3.0.1, d3-random 3.0.1, d3-scale 4.0.2, d3-selection 3.0.0, d3-time-format 4.1.0, d3-timer 3.0.1, d3-transition 3.0.1, d3-zoom 3.0.0.

```text
Copyright 2010-2021 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text 64c4e54df59c

Applies to: pkce-challenge 5.0.1.

```text
MIT License

Copyright (c) 2019

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 665f7d320f28

Applies to: @antfu/install-pkg 1.1.0.

```text
MIT License

Copyright (c) 2021 Anthony Fu <https://github.com/antfu>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 6821b85df472

Applies to: stylis 4.4.0.

```text
MIT License

Copyright (c) 2016-present Sultan Tarimo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 69af84a0cb48

Applies to: d3-ease 3.0.1.

```text
Copyright 2010-2021 Mike Bostock
Copyright 2001 Robert Penner
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the author nor the names of contributors may be used to
  endorse or promote products derived from this software without specific prior
  written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text 6a972b33787e

Applies to: csstype 3.2.3.

```text
Copyright (c) 2017-2018 Fredrik Nicol

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 6c1117dc530c

Applies to: @floating-ui/core 1.8.0, @floating-ui/dom 1.8.0, @floating-ui/react-dom 2.1.9, @floating-ui/utils 0.2.12.

```text
MIT License

Copyright (c) 2021-present Floating UI contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 6dfc8a41d27c

Applies to: layout-base 1.0.2, layout-base 2.0.1.

```text
MIT License

Copyright (c) 2019 iVis@Bilkent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 6efa74cb6d21

Applies to: cors 2.8.6.

```text
(The MIT License)

Copyright (c) 2013 Troy Goode <troygoode@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 711cb7cff0da

Applies to: @aws-sdk/client-bedrock-runtime 3.1127.0.

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2018-2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text 72bb6356e9ef

Applies to: fresh 2.0.0.

```text
(The MIT License)

Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca>
Copyright (c) 2016-2017 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 740bb4e91297

Applies to: graceful-fs 4.2.11.

```text
The ISC License

Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### License text 74144f6a3a6c

Applies to: @radix-ui/number 1.1.3, @radix-ui/primitive 1.1.7, @radix-ui/react-accessible-icon 1.1.15, @radix-ui/react-accordion 1.2.20, @radix-ui/react-alert-dialog 1.1.23, @radix-ui/react-arrow 1.1.15, @radix-ui/react-aspect-ratio 1.1.15, @radix-ui/react-avatar 1.2.6, @radix-ui/react-checkbox 1.3.11, @radix-ui/react-collapsible 1.1.20, @radix-ui/react-collection 1.1.15, @radix-ui/react-compose-refs 1.1.5, @radix-ui/react-context 1.2.2, @radix-ui/react-context-menu 2.3.7, @radix-ui/react-dialog 1.1.23, @radix-ui/react-direction 1.1.4, @radix-ui/react-dismissable-layer 1.1.19, @radix-ui/react-dropdown-menu 2.1.24, @radix-ui/react-focus-guards 1.1.6, @radix-ui/react-focus-scope 1.1.16, @radix-ui/react-form 0.1.16, @radix-ui/react-hover-card 1.1.23, @radix-ui/react-id 1.1.4, @radix-ui/react-label 2.1.15, @radix-ui/react-menu 2.1.24, @radix-ui/react-menubar 1.1.24, @radix-ui/react-navigation-menu 1.2.22, @radix-ui/react-one-time-password-field 0.1.16, @radix-ui/react-password-toggle-field 0.1.11, @radix-ui/react-popover 1.1.23, @radix-ui/react-popper 1.3.7, @radix-ui/react-portal 1.1.17, @radix-ui/react-presence 1.1.10, @radix-ui/react-primitive 2.1.10, @radix-ui/react-progress 1.1.16, @radix-ui/react-radio-group 1.4.7, @radix-ui/react-roving-focus 1.1.19, @radix-ui/react-scroll-area 1.2.18, @radix-ui/react-select 2.3.7, @radix-ui/react-separator 1.1.15, @radix-ui/react-slider 1.4.7, @radix-ui/react-slot 1.3.3, @radix-ui/react-switch 1.3.7, @radix-ui/react-tabs 1.1.21, @radix-ui/react-toast 1.2.23, @radix-ui/react-toggle 1.1.18, @radix-ui/react-toggle-group 1.1.19, @radix-ui/react-toolbar 1.1.19, @radix-ui/react-tooltip 1.2.16, @radix-ui/react-use-callback-ref 1.1.4, @radix-ui/react-use-controllable-state 1.2.6, @radix-ui/react-use-effect-event 0.0.5, @radix-ui/react-use-escape-keydown 1.1.5, @radix-ui/react-use-is-hydrated 0.1.3, @radix-ui/react-use-layout-effect 1.1.4, @radix-ui/react-use-previous 1.1.4, @radix-ui/react-use-rect 1.1.4, @radix-ui/react-use-size 1.1.4, @radix-ui/react-visually-hidden 1.2.11, @radix-ui/rect 1.1.3, radix-ui 1.6.7.

```text
MIT License

Copyright (c) 2022 WorkOS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 741668cc2214

Applies to: function-bind 1.1.2.

```text
Copyright (c) 2013 Raynos.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text 79157668b360

Applies to: protobufjs 7.6.6.

```text
This license applies to all parts of protobuf.js except those files
either explicitly including or referencing a different license or
located in a directory containing a different LICENSE file.

---

Copyright (c) 2016, Daniel Wirtz  All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of its author, nor the names of its contributors
  may be used to endorse or promote products derived from this software
  without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

---

Code generated by the command line utilities is owned by the owner
of the input file used when generating it. This code is not
standalone and requires a support library to be linked with it. This
support library is itself covered by the above license.
```

### License text 79d0fc447160

Applies to: fast-sha256 1.3.0, robust-predicates 3.0.3.

```text
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org>
```

### License text 7adebaeee45b

Applies to: ws 8.21.0, ws 8.21.1.

```text
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 7ae85337f549

Applies to: side-channel 1.1.1, side-channel-weakmap 1.0.2.

```text
MIT License

Copyright (c) 2019 Jordan Harband

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 7bdac5ba137b

Applies to: @upsetjs/venn.js 2.0.0.

```text
MIT License

Copyright (c) 2013 Ben Frederickson
Copyright (c) 2021 Samuel Gratzl

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 7cb4d976f1c8

Applies to: body-parser 2.3.0, type-is 2.1.0.

```text
(The MIT License)

Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>
Copyright (c) 2014-2015 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 7d52eae0c2f0

Applies to: openai 6.40.0.

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2026 OpenAI

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text 7ed7c157c417

Applies to: bignumber.js 9.3.1.

```text
The MIT License (MIT)
=====================

Copyright © `<2025>` `Michael Mclaughlin`

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the “Software”), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

### License text 7edf453d1584

Applies to: @capacitor/core 8.4.0.

```text
MIT License

Copyright (c) 2017-present Drifty Co.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 7fb46adff902

Applies to: @aws/lambda-invoke-store 0.3.0.

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.
```

### License text 80d3168ad2f7

Applies to: zod-to-json-schema 3.25.2.

```text
ISC License

Copyright (c) 2020, Stefan Terdell

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### License text 811223f2d339

Applies to: bytes 3.1.2.

```text
(The MIT License)

Copyright (c) 2012-2014 TJ Holowaychuk <tj@vision-media.ca>
Copyright (c) 2015 Jed Watson <jed.watson@me.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 84a6a26e0f60

Applies to: oniguruma-to-es 4.3.6.

```text
MIT License

Copyright (c) 2024-2026 Steven Levithan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 8694aa57bec3

Applies to: @modelcontextprotocol/sdk 1.30.0.

```text
MIT License

Copyright (c) 2024 Anthropic, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 887ee21f80fd

Applies to: finalhandler 2.1.1.

```text
(The MIT License)

Copyright (c) 2014-2022 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 8a160f8ccc7b

Applies to: negotiator 1.0.0.

```text
(The MIT License)

Copyright (c) 2012-2014 Federico Romero
Copyright (c) 2012-2014 Isaac Z. Schlueter
Copyright (c) 2014-2015 Douglas Christopher Wilson

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 8c46e0985782

Applies to: node-domexception 1.0.0.

```text
MIT License

Copyright (c) 2021 Jimmy Wärting

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 8d512baec1ac

Applies to: toidentifier 1.0.1.

```text
MIT License

Copyright (c) 2016 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 8d8c55319c77

Applies to: agent-base 7.1.4, agent-base 9.0.0, http-proxy-agent 9.1.0, https-proxy-agent 7.0.6, https-proxy-agent 9.1.0.

```text
(The MIT License)

Copyright (c) 2013 Nathan Rajlich <nathan@tootallnate.net>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 8e1c6bd583a7

Applies to: @types/retry 0.12.0.

```text
MIT License

    Copyright (c) Microsoft Corporation. All rights reserved.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE
```

### License text 8f08c824b2bb

Applies to: @babel/runtime 7.29.2, @babel/runtime 7.29.7.

```text
MIT License

Copyright (c) 2014-present Sebastian McKenzie and other contributors

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 8fc1d534e3ef

Applies to: @capawesome/capacitor-electron 0.1.0.

```text
MIT License

Copyright (c) 2026 Robin Genz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 90ee3cca58da

Applies to: cose-base 1.0.3, cose-base 2.2.0.

```text
MIT License

Copyright (c) 2019 - present, iVis@Bilkent.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 90f7e57f32c5

Applies to: preact-render-to-string 6.6.5.

```text
The MIT License (MIT)

Copyright (c) 2015 Jason Miller

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 9116bd624634

Applies to: mime-db 1.54.0.

```text
(The MIT License)

Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>
Copyright (c) 2015-2022 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 9179082f29f0

Applies to: parseurl 1.3.3.

```text
(The MIT License)

Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>
Copyright (c) 2014-2017 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 928a86b1d298

Applies to: hasown 2.0.4.

```text
MIT License

Copyright (c) Jordan Harband and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 93321073ebe5

Applies to: express 5.2.1.

```text
(The MIT License)

Copyright (c) 2009-2014 TJ Holowaychuk <tj@vision-media.ca>
Copyright (c) 2013-2014 Roman Shtylman <shtylman+expressjs@gmail.com>
Copyright (c) 2014-2015 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 937e8ea6d28e

Applies to: require-from-string 2.0.2.

```text
The MIT License (MIT)

Copyright (c) Vsevolod Strukchinsky <floatdrop@gmail.com> (github.com/floatdrop)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text 94228ab8fc0b

Applies to: mermaid 11.16.1.

```text
The MIT License (MIT)

Copyright (c) 2014 - 2022 Knut Sveidqvist

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 95b423fd389e

Applies to: formdata-polyfill 4.0.10.

```text
MIT License

Copyright (c) 2016 Jimmy Karl Roland Wärting

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 98a2c2007296

Applies to: range-parser 1.3.0.

```text
(The MIT License)

Copyright (c) 2012-2014 TJ Holowaychuk <tj@vision-media.ca>
Copyright (c) 2015-2016 Douglas Christopher Wilson <doug@somethingdoug.com

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 9a08965c44ca

Applies to: cron-parser 5.6.0.

```text
The MIT License (MIT)

Copyright (c) 2014-2023 Harri Siirak

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 9c94db23dc4b

Applies to: ignore 7.0.8.

```text
Copyright (c) 2013 Kael Zhang <i@kael.me>, contributors
http://kael.me/

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 9cac2500def4

Applies to: inline-style-parser 0.2.7.

```text
(The MIT License)

Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text 9d00baf34d17

Applies to: d3-fetch 3.0.1.

```text
Copyright 2016-2021 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text 9f5ea8f5a268

Applies to: cytoscape-fcose 2.2.0.

```text
Copyright (c) 2018 - present, iVis-at-Bilkent.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the “Software”), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text 9fe3e95ca3e8

Applies to: d3-format 3.1.2.

```text
Copyright 2010-2026 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text a05c505267a8

Applies to: get-nonce 1.0.1.

```text
MIT License

Copyright (c) 2020 Anton Korzunov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text a1563f431b1f

Applies to: unist-util-is 6.0.1.

```text
(The MIT license)

Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text a3fb4c94aaf6

Applies to: accepts 2.0.0, mime-types 3.0.2.

```text
(The MIT License)

Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>
Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text a734fd0e3f64

Applies to: path-data-parser 0.1.0, points-on-curve 0.2.0.

```text
MIT License

Copyright (c) 2020 Preet Shihn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text a73647cf797f

Applies to: oniguruma-parser 0.12.2.

```text
MIT License

Copyright (c) 2025-2026 Steven Levithan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text a86793ac0231

Applies to: @iconify/utils 3.1.4.

```text
MIT License

Copyright (c) 2021-PRESENT Vjacheslav Trushkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text aa407ee69b3f

Applies to: fast-deep-equal 3.1.3, json-schema-traverse 1.0.0.

```text
MIT License

Copyright (c) 2017 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text aa4c6585f201

Applies to: minimatch 10.2.6.

```text
# Blue Oak Model License

Version 1.0.0

## Purpose

This license gives everyone as much permission to work with
this software as possible, while protecting contributors
from liability.

## Acceptance

In order to receive this license, you must agree to its
rules. The rules of this license are both obligations
under that agreement and conditions to your license.
You must not do anything with this software that triggers
a rule that you cannot or will not follow.

## Copyright

Each contributor licenses you to do everything with this
software that would otherwise infringe that contributor's
copyright in it.

## Notices

You must ensure that everyone who gets a copy of
any part of this software from you, with or without
changes, also gets the text of this license or a link to
<https://blueoakcouncil.org/license/1.0.0>.

## Excuse

If anyone notifies you in writing that you have not
complied with [Notices](#notices), you can keep your
license by taking all practical steps to comply within 30
days after the notice. If you do not do so, your license
ends immediately.

## Patent

Each contributor licenses you to do everything with this
software that would otherwise infringe any patent claims
they can license or become able to license.

## Reliability

No contributor can revoke this license.

## No Liability

**_As far as the law allows, this software comes as is,
without any warranty or condition, and no contributor
will be liable to anyone for any damages related to this
software or this license, under any kind of legal claim._**
```

### License text aa72fb6117e4

Applies to: safer-buffer 2.1.2.

```text
MIT License

Copyright (c) 2018 Nikita Skovoroda <chalkerx@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text ac1f2978a646

Applies to: package-manager-detector 1.8.0.

```text
MIT License

Copyright (c) 2020-PRESENT Anthony Fu <https://github.com/antfu>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text ac29541ee357

Applies to: grok-mermaid 0.2.3.

```text
Copyright 2023-2026 SpaceXAI
Copyright 2026 Alexey Zaytsev


                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text ad66ea5b7919

Applies to: ipaddr.js 1.9.1.

```text
Copyright (C) 2011-2017 whitequark <whitequark@whitequark.org>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text af2be7b670a0

Applies to: @anthropic-ai/claude-agent-sdk 0.3.274.

```text
© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.
```

### License text b010b0dfdfdb

Applies to: fast-uri 3.1.5.

```text
Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae
Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * The names of any contributors may not be used to endorse or promote
      products derived from this software without specific prior written
      permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

                                  *   *   *

The complete list of contributors can be found at:
- https://github.com/garycourt/uri-js/graphs/contributors
```

### License text b079b743d39a

Applies to: extend 3.0.2.

```text
The MIT License (MIT)

Copyright (c) 2014 Stefan Thomas

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text b09ac0e46520

Applies to: @shikijs/vscode-textmate 10.0.2.

```text
The MIT License (MIT)

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text b25c1d68b353

Applies to: tailwind-merge 3.6.0.

```text
MIT License

Copyright (c) 2021 Dany Castillo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text b279be1458cd

Applies to: http-errors 2.0.1.

```text
The MIT License (MIT)

Copyright (c) 2014 Jonathan Ong me@jongleberry.com
Copyright (c) 2016 Douglas Christopher Wilson doug@somethingdoug.com

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text b2bf1d8ed89e

Applies to: escape-html 1.0.3.

```text
(The MIT License)

Copyright (c) 2012-2013 TJ Holowaychuk
Copyright (c) 2015 Andreas Lubbe
Copyright (c) 2015 Tiancheng "Timothy" Gu

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text b4d257dd0d1c

Applies to: encodeurl 2.0.0.

```text
(The MIT License)

Copyright (c) 2016 Douglas Christopher Wilson

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text b5954f59305d

Applies to: raw-body 3.0.2.

```text
The MIT License (MIT)

Copyright (c) 2013-2014 Jonathan Ong <me@jongleberry.com>
Copyright (c) 2014-2022 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text b72c84b52e8f

Applies to: partial-json 0.1.7.

```text
MIT License

Copyright (c) 2023 Promplate Dev Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text b7972f57b949

Applies to: react-markdown 10.1.0.

```text
The MIT License (MIT)

Copyright (c) Espen Hovlandsdal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text b970cfe4a7f3

Applies to: cookie 0.7.2.

```text
(The MIT License)

Copyright (c) 2012-2014 Roman Shtylman <shtylman@gmail.com>
Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text bb62e07404e8

Applies to: roughjs 4.6.6.

```text
MIT License

Copyright (c) 2019 Preet Shihn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text bc11a2b203c7

Applies to: statuses 2.0.2.

```text
The MIT License (MIT)

Copyright (c) 2014 Jonathan Ong <me@jongleberry.com>
Copyright (c) 2016 Douglas Christopher Wilson <doug@somethingdoug.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text bdbe1c003ac6

Applies to: cookie-signature 1.2.2.

```text
(The MIT License)

Copyright (c) 2012–2024 LearnBoost <tj@learnboost.com> and other contributors;

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text bdda7d25f6d1

Applies to: style-to-js 1.1.21.

```text
The MIT License (MIT)

Copyright (c) 2020 Menglin "Mark" Xu <mark@remarkablemark.org>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text be61dfc96bbf

Applies to: class-variance-authority 0.7.1.

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   Copyright 2022 Joe Bell

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text bef9ee0b92a1

Applies to: @silvia-odwyer/photon-node 0.3.4.

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2023, Silvia O'Dwyer

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text bfe1e5d7dd50

Applies to: @fontsource-variable/inter 5.3.0.

```text
Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) Inter-Italic[opsz,wght].ttf: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

### License text c09860913a77

Applies to: get-proto 1.0.1.

```text
MIT License

Copyright (c) 2025 Jordan Harband

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text c37a32dd1cd4

Applies to: bail 2.0.2, ccount 2.0.1, character-entities 2.0.2, character-entities-html4 2.1.0, character-entities-legacy 3.0.0, character-reference-invalid 2.0.1, mdast-util-to-string 4.0.0, unist-util-position 5.0.0, unist-util-visit 5.1.0.

```text
(The MIT License)

Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text c434897a5a6c

Applies to: @xterm/addon-unicode11 0.9.0.

```text
Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text c74f9c5a522f

Applies to: parse-entities 4.0.2, property-information 7.2.0.

```text
(The MIT License)

Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text c8ea45f591c2

Applies to: d3-contour 4.0.2.

```text
Copyright 2012-2023 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text c9808a775260

Applies to: p-retry 4.6.2, path-key 3.1.1, shebang-regex 3.0.0.

```text
MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text cab518dd82c2

Applies to: node-pty 1.1.0.

```text
Copyright (c) 2012-2015, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.



The MIT License (MIT)

Copyright (c) 2016, Daniel Imms (http://www.growingwiththeweb.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.



MIT License

Copyright (c) 2018 - present Microsoft Corporation

All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text ce471b4b8188

Applies to: base64-js 1.5.1.

```text
The MIT License (MIT)

Copyright (c) 2014 Jameson Little

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text cf12d35c36ba

Applies to: yaml 2.9.0.

```text
Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text cf9b17822d1f

Applies to: react 19.2.8, react-dom 19.2.8, scheduler 0.27.0.

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text d0a8e5996a99

Applies to: dequal 2.0.3.

```text
The MIT License (MIT)

Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text d28e1b882ecc

Applies to: hosted-git-info 9.0.3.

```text
Copyright (c) 2015, Rebecca Turner

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### License text d298496454d4

Applies to: @anthropic-ai/sdk 0.124.0.

```text
Copyright 2023 Anthropic, PBC.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text d3c8c167dfa0

Applies to: katex 0.16.47.

```text
The MIT License (MIT)

Copyright (c) 2013-2020 Khan Academy and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text d3de97fbfe54

Applies to: hachure-fill 0.5.2.

```text
MIT License

Copyright (c) 2023 Preet Shihn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text d4317f690ad0

Applies to: cytoscape 3.34.0.

```text
import fs from 'fs';
import path from 'path';

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const year = (new Date()).getFullYear();

const license = `Copyright (c) 2016-${year}, The Cytoscape Consortium.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the “Software”), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

fs.writeFileSync(path.join(__dirname, 'LICENSE'), license);
```

### License text d48d15a12e71

Applies to: merge-descriptors 2.0.0.

```text
MIT License

Copyright (c) Jonathan Ong <me@jongleberry.com>
Copyright (c) Douglas Christopher Wilson <doug@somethingdoug.com>
Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text d68cfda21300

Applies to: ee-first 1.1.1.

```text
The MIT License (MIT)

Copyright (c) 2014 Jonathan Ong me@jongleberry.com

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text d6f4fc856b99

Applies to: jose 6.2.5.

```text
The MIT License (MIT)

Copyright (c) 2018 Filip Skokan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text d80ea12109c5

Applies to: serve-static 2.2.1.

```text
(The MIT License)

Copyright (c) 2010 Sencha Inc.
Copyright (c) 2011 LearnBoost
Copyright (c) 2011 TJ Holowaychuk
Copyright (c) 2014-2016 Douglas Christopher Wilson

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text d82ceb8cbd00

Applies to: @aws-sdk/credential-provider-env 3.972.70, @aws-sdk/credential-provider-env 3.972.71, @aws-sdk/credential-provider-ini 3.973.15, @aws-sdk/credential-provider-ini 3.973.16, @aws-sdk/credential-provider-node 3.972.82, @aws-sdk/credential-provider-node 3.972.83, @aws-sdk/middleware-eventstream 3.972.29, @aws-sdk/token-providers 3.1116.0, @aws-sdk/token-providers 3.1127.0, @aws-sdk/token-providers 3.1129.0, @aws-sdk/types 3.974.5, @aws-sdk/xml-builder 3.972.40, @smithy/credential-provider-imds 4.5.2, @smithy/fetch-http-handler 5.8.0, @smithy/node-http-handler 4.12.1, @smithy/signature-v4 5.7.3.

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2018-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text d872b89e34b7

Applies to: @mermaid-js/parser 1.2.0.

```text
The MIT License (MIT)

Copyright (c) 2023 Yokozuna59

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text d9c32f07344c

Applies to: comma-separated-tokens 2.0.3, hast-util-whitespace 3.0.0, html-void-elements 3.0.0, is-alphabetical 2.0.1, is-alphanumerical 2.0.1, is-decimal 2.0.1, is-hexadecimal 2.0.1, mdast-util-to-hast 13.2.1, space-separated-tokens 2.0.2, unist-util-stringify-position 4.0.0, unist-util-visit-parents 6.0.2, zwitch 2.0.4.

```text
(The MIT License)

Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text d9e5aa2747f3

Applies to: debug 4.4.3.

```text
(The MIT License)

Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca>
Copyright (c) 2018-2021 Josh Junon

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the 'Software'), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text da98afd61ac8

Applies to: fetch-blob 3.2.0.

```text
MIT License

Copyright (c) 2019 David Frank

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text db05b3b0f72f

Applies to: setprototypeof 1.2.0.

```text
Copyright (c) 2015, Wes Todd

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### License text dd58f6060d93

Applies to: object-inspect 1.13.4.

```text
MIT License

Copyright (c) 2013 James Halliday

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text dd923de97698

Applies to: marked 16.4.2, marked 18.0.11.

```text
# License information

## Contribution License Agreement

If you contribute code to this project, you are implicitly allowing your code
to be distributed under the MIT license. You are also implicitly verifying that
all code is your original work. `</legalese>`

## Marked

Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## Markdown

Copyright © 2004, John Gruber
http://daringfireball.net/
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
* Neither the name “Markdown” nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

This software is provided by the copyright holders and contributors “as is” and any express or implied warranties, including, but not limited to, the implied warranties of merchantability and fitness for a particular purpose are disclaimed. In no event shall the copyright owner or contributors be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, procurement of substitute goods or services; loss of use, data, or profits; or business interruption) however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence or otherwise) arising in any way out of the use of this software, even if advised of the possibility of such damage.
```

### License text dff1a84cb703

Applies to: safe-buffer 5.2.1.

```text
The MIT License (MIT)

Copyright (c) Feross Aboukhadijeh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text e11634cfe7bf

Applies to: mdast-util-phrasing 4.1.0.

```text
(The MIT License)

Copyright (c) 2017 Titus Wormer <tituswormer@gmail.com>
Copyright (c) 2017 Victor Felder <victor@draft.li>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text e1da326aaf68

Applies to: trough 2.2.0.

```text
(The MIT License)

Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text e257f36bcf5e

Applies to: path-to-regexp 8.4.2.

```text
The MIT License (MIT)

Copyright (c) 2014 Blake Embrey (hello@blakeembrey.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text e453dafb35c9

Applies to: unified 11.0.5, vfile 6.0.3.

```text
(The MIT License)

Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text e4f413b3ca5e

Applies to: eventsource 3.0.7.

```text
The MIT License

Copyright (c) EventSource GitHub organisation

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text e87ae4ac338d

Applies to: d3-geo 3.1.1.

```text
Copyright 2010-2024 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.

This license applies to GeographicLib, versions 1.12 and later.

Copyright 2008-2012 Charles Karney

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text e8a7cc256941

Applies to: typebox 1.3.27, typebox 1.3.7.

```text
TypeBox

The MIT License (MIT)

Copyright (c) 2017-2026 Haydn Paterson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text e8e2fe35f5fd

Applies to: @agentclientprotocol/sdk 1.3.0.

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   Copyright 2025 Zed Industries, Inc. and contributors

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text e91069c31b4e

Applies to: ms 2.1.3.

```text
The MIT License (MIT)

Copyright (c) 2020 Vercel, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text ea559213e0e9

Applies to: decode-named-character-reference 1.3.0, hast-util-to-html 9.0.5, hast-util-to-jsx-runtime 2.3.6, markdown-table 3.0.4, mdast-util-find-and-replace 3.0.2, mdast-util-from-markdown 2.0.3, mdast-util-gfm 3.1.0, mdast-util-gfm-footnote 2.1.0, mdast-util-to-markdown 2.1.2, micromark 4.0.2, micromark-core-commonmark 2.0.3, micromark-extension-gfm-table 2.1.1, micromark-factory-destination 2.0.1, micromark-factory-label 2.0.1, micromark-factory-space 2.0.1, micromark-factory-title 2.0.1, micromark-factory-whitespace 2.0.1, micromark-util-character 2.1.1, micromark-util-chunked 2.0.1, micromark-util-classify-character 2.0.1, micromark-util-combine-extensions 2.0.1, micromark-util-decode-numeric-character-reference 2.0.2, micromark-util-decode-string 2.0.1, micromark-util-encode 2.0.1, micromark-util-html-tag-name 2.0.1, micromark-util-normalize-identifier 2.0.1, micromark-util-resolve-all 2.0.1, micromark-util-sanitize-uri 2.0.1, micromark-util-subtokenize 2.1.0, micromark-util-symbol 2.0.1, micromark-util-types 2.0.2, remark-gfm 4.0.1, remark-rehype 11.1.2, vfile-message 4.0.3.

```text
(The MIT License)

Copyright (c) Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text eabb8d3cadaf

Applies to: highlight.js 10.7.3.

```text
BSD 3-Clause License

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text eb319c6e6f23

Applies to: cytoscape 3.34.0.

```text
Copyright (c) 2016-2026, The Cytoscape Consortium.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the “Software”), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text eb99a0d61b50

Applies to: @capacitor/app 8.1.0, @capacitor/keyboard 8.0.5, @capacitor/preferences 8.0.1.

```text
Copyright 2020-present Ionic
https://ionic.io

MIT License

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text ecc934075c78

Applies to: preact 11.0.0-beta.0.

```text
The MIT License (MIT)

Copyright (c) 2015-present Jason Miller

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text edea91454b81

Applies to: @aws-sdk/core 3.977.9, @aws-sdk/core 3.978.0.

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### License text ee35498e6684

Applies to: lucide-react 1.27.0.

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text ef7eb99d9a97

Applies to: diff 8.0.4, diff 9.0.0.

```text
BSD 3-Clause License

Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text f175d4a76efe

Applies to: jwa 2.0.1, jws 4.0.1.

```text
Copyright (c) 2013 Brian J. Brennan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text f20e2ee5da6c

Applies to: @shikijs/core 4.4.2, @shikijs/engine-javascript 4.4.2, @shikijs/engine-oniguruma 4.4.2, @shikijs/langs 4.4.2, @shikijs/primitive 4.4.2, @shikijs/themes 4.4.2, @shikijs/transformers 4.4.2, @shikijs/types 4.4.2, shiki 4.4.2.

```text
MIT License

Copyright (c) 2021 Pine Wu
Copyright (c) 2023 Anthony Fu <https://github.com/antfu>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text f2b90afb27a6

Applies to: esbuild 0.28.2.

```text
MIT License

Copyright (c) 2020 Evan Wallace

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text f2fde84e6c1f

Applies to: ajv 8.20.0.

```text
The MIT License (MIT)

Copyright (c) 2015-2021 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text f3166fa57273

Applies to: ghostty-web 0.4.0.

```text
MIT License

Copyright (c) 2025 Coder

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text f36e2da26df2

Applies to: brace-expansion 5.0.9.

```text
MIT License

Copyright Julian Gruber <julian@juliangruber.com>

TypeScript port Copyright Isaac Z. Schlueter <i@izs.me>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text f4b733956caa

Applies to: send 1.2.1.

```text
(The MIT License)

Copyright (c) 2012 TJ Holowaychuk
Copyright (c) 2014-2022 Douglas Christopher Wilson

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text f4bb8f655fdb

Applies to: internmap 1.0.1, internmap 2.0.3.

```text
Copyright 2021 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text f526adb7b81e

Applies to: regex 6.1.0, regex-recursion 6.0.2.

```text
MIT License

Copyright (c) 2025 Steven Levithan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text f57e3a2cabf2

Applies to: d3 7.9.0, d3-array 3.2.4.

```text
Copyright 2010-2023 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### License text f61cacc2acb8

Applies to: zod 4.4.3.

```text
MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text f7673e959327

Applies to: jiti 2.7.0.

```text
MIT License

Copyright (c) Pooya Parsa <pooya@pi0.io>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text f78777570e32

Applies to: remark-parse 11.0.0, remark-stringify 11.0.0.

```text
(The MIT License)

Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### License text f889cb863a1f

Applies to: depd 2.0.0.

```text
(The MIT License)

Copyright (c) 2014-2018 Douglas Christopher Wilson

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text f8f62778c92d

Applies to: luxon 3.7.2.

```text
Copyright 2019 JS Foundation and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text faa1180b6bfe

Applies to: json-bigint 1.0.0.

```text
The MIT License (MIT)

Copyright (c) 2013 Andrey Sidorov

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text fb06d5b872e5

Applies to: content-type 1.0.5, content-type 2.0.0.

```text
(The MIT License)

Copyright (c) 2015 Douglas Christopher Wilson

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### License text fc5c72a172de

Applies to: signal-exit 3.0.7.

```text
The ISC License

Copyright (c) 2015, Contributors

Permission to use, copy, modify, and/or distribute this software
for any purpose with or without fee is hereby granted, provided
that the above copyright notice and this permission notice
appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE
LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### License text fda0e18e4dc7

Applies to: web-streams-polyfill 3.3.3.

```text
The MIT License (MIT)

Copyright (c) 2024 Mattias Buelens
Copyright (c) 2016 Diwank Singh Tomer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text fdb3f0dc5ffa

Applies to: has-symbols 1.1.0.

```text
MIT License

Copyright (c) 2016 Jordan Harband

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text fe1812441c6d

Applies to: @stablelib/base64 1.0.1.

```text
This software is licensed under the MIT license:

Copyright (C) 2016 Dmitry Chestnykh

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text fe64958bfaef

Applies to: undici 8.10.2, undici-types 6.21.0, undici-types 8.3.0.

```text
MIT License

Copyright (c) Matteo Collina and Undici contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### License text ff750f6d635d

Applies to: json-schema-typed 8.0.2.

```text
BSD 2-Clause License

Original source code is copyright (c) 2019-2025 Remy Rylan
<https://github.com/RemyRylan>

All JSON Schema documentation and descriptions are copyright (c):

2009 [draft-0] IETF Trust <https://www.ietf.org/>, Kris Zyp <kris@sitepen.com>,
and SitePen (USA) <https://www.sitepen.com/>.

2009 [draft-1] IETF Trust <https://www.ietf.org/>, Kris Zyp <kris@sitepen.com>,
and SitePen (USA) <https://www.sitepen.com/>.

2010 [draft-2] IETF Trust <https://www.ietf.org/>, Kris Zyp <kris@sitepen.com>,
and SitePen (USA) <https://www.sitepen.com/>.

2010 [draft-3] IETF Trust <https://www.ietf.org/>, Kris Zyp <kris@sitepen.com>,
Gary Court <gary.court@gmail.com>, and SitePen (USA) <https://www.sitepen.com/>.

2013 [draft-4] IETF Trust <https://www.ietf.org/>), Francis Galiegue
<fgaliegue@gmail.com>, Kris Zyp <kris@sitepen.com>, Gary Court
<gary.court@gmail.com>, and SitePen (USA) <https://www.sitepen.com/>.

2018 [draft-7] IETF Trust <https://www.ietf.org/>, Austin Wright <aaa@bzfx.net>,
Henry Andrews <henry@cloudflare.com>, Geraint Luff <luffgd@gmail.com>, and
Cloudflare, Inc. <https://www.cloudflare.com/>.

2019 [draft-2019-09] IETF Trust <https://www.ietf.org/>, Austin Wright
<aaa@bzfx.net>, Henry Andrews <andrews_henry@yahoo.com>, Ben Hutton
<bh7@sanger.ac.uk>, and Greg Dennis <gregsdennis@yahoo.com>.

2020 [draft-2020-12] IETF Trust <https://www.ietf.org/>, Austin Wright
<aaa@bzfx.net>, Henry Andrews <andrews_henry@yahoo.com>, Ben Hutton
<ben@jsonschema.dev>, and Greg Dennis <gregsdennis@yahoo.com>.

All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### License text ff82c90f8494

Applies to: @types/d3 7.4.3, @types/d3-array 3.2.2, @types/d3-axis 3.0.6, @types/d3-brush 3.0.6, @types/d3-chord 3.0.6, @types/d3-color 3.1.3, @types/d3-contour 3.0.6, @types/d3-delaunay 6.0.4, @types/d3-dispatch 3.0.7, @types/d3-drag 3.0.7, @types/d3-dsv 3.0.7, @types/d3-ease 3.0.2, @types/d3-fetch 3.0.7, @types/d3-force 3.0.10, @types/d3-format 3.0.4, @types/d3-geo 3.1.1, @types/d3-hierarchy 3.1.7, @types/d3-interpolate 3.0.4, @types/d3-path 3.1.1, @types/d3-polygon 3.0.2, @types/d3-quadtree 3.0.6, @types/d3-random 3.0.4, @types/d3-scale 4.0.9, @types/d3-scale-chromatic 3.1.0, @types/d3-selection 3.0.11, @types/d3-shape 3.1.8, @types/d3-time 3.0.4, @types/d3-time-format 4.0.3, @types/d3-timer 3.0.2, @types/d3-transition 3.0.9, @types/d3-zoom 3.0.8, @types/debug 4.1.13, @types/estree 1.0.9, @types/estree-jsx 1.0.5, @types/geojson 7946.0.16, @types/hast 3.0.5, @types/mdast 4.0.4, @types/ms 2.1.0, @types/node 22.19.19, @types/node 26.1.2, @types/react 19.2.17, @types/trusted-types 2.0.7, @types/unist 2.0.11, @types/unist 3.0.3.

```text
MIT License

    Copyright (c) Microsoft Corporation.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE
```
