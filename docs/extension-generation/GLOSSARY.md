# Semantic Extension Framework

The planned cross-host runtime framework: my-omp-toolkit extensions consume a separate package containing shared semantic behaviors and pi/oh-my-pi adapters. A standalone extension generator is a possible later distribution feature, not part of the initial framework.

## Language

**Runtime framework package（运行时框架包）**:
The separately maintained package an extension depends on when it runs, providing shared semantic behaviors and adapters for supported hosts.
_Avoid_: standalone generated extension, copy-pasted template

**Extension definition（扩展定义）**:
The configuration and optional shared TypeScript logic describing an extension independently of a particular host.
_Avoid_: host-specific entrypoint, generated extension

**Generated extension（生成扩展）**:
A host-targeted standalone extension produced from an extension definition by a potential future distribution tool, not the initial runtime-package approach. A manually customized copy would be maintained independently of that definition.
_Avoid_: initial runtime-package consumer, synchronized source

**Semantic hook（语义钩子）**:
A framework-defined lifecycle position where one host-independent extension function can run across supported agents. The host adapter identifies the corresponding native trigger and supplies the framework's semantic inputs.
_Avoid_: native event name, template text slot

**Configuration switch（配置式开关）**:
An activation choice read at initialization whose changes do not take effect during the current run; applying a changed choice requires a restart.
_Avoid_: runtime toggle, mode command

**Mode selection（模式设置）**:
An explicit request for a named mode. Selecting an already active mode leaves it active without repeating mode-transition side effects.
_Avoid_: toggle, inversion

**Command toggle（命令切换）**:
A command that alternates between two modes on successive executions.
_Avoid_: mode selection, idempotent switch

**Mixed control（混合控制）**:
A control scheme combining explicit mode selection and command toggling over the same mode state.
_Avoid_: a fourth mode, independent switches

**Command action（命令动作）**:
An extension subfeature invoked to perform an operation, rather than to select or alternate a mode.
_Avoid_: mode transition, toggle

**Parameter setting（参数设置）**:
An extension subfeature that assigns a supplied value to a parameter; it does not inherently activate or deactivate the extension.
_Avoid_: mode selection, command action

**State**:
The framework's single current-value source for an extension, including framework-defined and extension-defined values. Persistence media and external providers can supply observations, but framework-managed behaviors read current values from State.
_Avoid_: UI-only variable bag, persistence backend, unscoped global object

**Extension storage（扩展存储）**:
The retention mechanism for extension-owned state and business data, including in-memory values, host-owned session entries, extension-owned files, and archives. It does not by itself determine which session or other owner a value belongs to.
_Avoid_: session restoration, persistence (when referring only to volatile memory)

**Recovery reconciliation（恢复后对齐）**:
The decision whether and how a restored state should reacquire ongoing effects whose earlier execution may no longer be active. Restoring a stored value alone does not establish that timers or external registrations are running.
_Avoid_: replaying the last command, automatic side-effect restoration

**Instruction contribution（指令贡献）**:
Extension-provided text made available to the model under declared activation and delivery rules. Its visibility to the user, authority, and retention are distinct properties.
_Avoid_: hidden developer message (as a synonym for all contributions), raw text insertion

**History preservation（历史保护）**:
A policy under which framework-managed behavior preserves existing conversation entries and their order in history-derived request content. New recorded messages may be appended; separate non-persisted contributions have their own placement rules, and cache hits are not guaranteed.
_Avoid_: identical-to-history request, cache-hit guarantee, immutable business storage

**Request-only contribution（请求级临时贡献）**:
Extension-provided content included in a model request without being added to the host's conversation history. Its placement and recurrence are separate from its non-persisted lifetime.
_Avoid_: persisted hidden message, history entry

**Supported-host baseline（宿主支持基线）**:
The declared host versions and applicable conditions against which shared extension behaviors are supported, together with their verification status. An inspected version is not automatically a supported or runtime-verified target.
_Avoid_: latest versions, universal compatibility, source version alone

**Behavior library（行为库）**:
Reusable host-independent extension behaviors that an extension definition selects and configures.
_Avoid_: host API wrappers, feature-specific business logic

**Feature template（功能模板）**:
A reusable combination of behaviors and feature-specific logic that can produce an extension from supplied configuration.
_Avoid_: semantic core, generated extension
