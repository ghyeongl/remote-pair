# Onboarding flow (client + host)

Redesigned onboarding flow for the client (IDE webview) and host (macOS app),
including the client-side "Onboarding completion Guard" and the host-side
"Host onboarding guard". Rendered from the Excalidraw design.

Guard convention: vertical edges between decision diamonds are the **Yes** path;
horizontal edges to an action node are the **No** (repair) path — each failed
gate drops to its matching repair step, then re-probes.

```mermaid
flowchart TD
    %% ===== Client =====
    subgraph Client
        direction TB
        C_Client((Client))
        C_Welcome["Welcome"]
        C_Consent["Consent"]
        C_HostInstalled{"Is your host<br/>installed?"}
        C_Discover["Discover<br/>LAN+Tailscale<br/>& Select"]
        C_Update["Request & Do Update"]
        C_WaitPerm["Waiting for<br/>Permission grant"]
        C_FolderMap["Folder mappings"]
        C_Done((Done))
    end

    C_Client --> C_Welcome
    C_Welcome --> C_Consent
    C_Consent --> C_HostInstalled
    C_HostInstalled --> C_Discover
    C_Discover --> C_Update
    C_Discover --> C_WaitPerm
    C_Update --> C_WaitPerm
    C_WaitPerm --> C_FolderMap
    C_FolderMap --> C_Done

    %% ===== Onboarding completion Guard =====
    %% 세로(마름모간) = Yes, 가로(액션노드로) = No
    subgraph OG ["Onboarding completion Guard"]
        direction TB
        G_CLI{"Is CLI ready?"}
        G_Connected{"Is your host<br/>connected?"}
        G_Version{"Is your host<br/>version compatible?"}
        G_Perm{"Is your host have<br/>sufficient permission<br/>& Accepted?"}
        G_Mapping{"Is least a mapping<br/>exist and working<br/>(mounted)?"}
    end

    G_CLI -->|Yes| G_Connected
    G_Connected -->|Yes| G_Version
    G_Version -->|Yes| G_Perm
    G_Perm -->|Yes| G_Mapping
    G_Mapping -->|Yes| C_Done

    G_CLI -->|No| C_Consent
    G_Connected -->|No| C_Discover
    G_Version -->|No| C_Update
    G_Perm -->|No| C_WaitPerm
    G_Mapping -->|No| C_FolderMap

    %% ===== Host =====
    subgraph Host
        direction TB
        H_Host((Host))
        H_Consent["Consent"]
        H_CheckPerm["Check Permission<br/>(Remote Login, AX,<br/>SR, FD, File sharing)"]
        H_Engine["Choose Engine<br/>(Claude, Codex,<br/>Opencode)"]
        H_Broadcast["Broadcasting &<br/>Accept or Deny Client"]
        H_Done((Done))
    end

    H_Host --> H_Consent
    H_Consent --> H_CheckPerm
    H_CheckPerm --> H_Engine
    H_Engine --> H_Broadcast
    H_Broadcast --> H_Done

    %% ===== Host onboarding guard (오른쪽 박스) =====
    subgraph HG ["Host onboarding guard"]
        direction TB
        HG_Perm{"Is host have<br/>Sufficient permission?"}
        HG_Engine{"Is host have<br/>at least one engine?"}
    end

    HG_Perm -->|Yes| HG_Engine
    HG_Perm -->|No| H_CheckPerm
    HG_Engine -->|Yes| H_Done
    HG_Engine -->|No| H_Engine

    %% ===== Client <-> Host 교차 연결 =====
    H_Broadcast -->|"If host accept"| C_WaitPerm
    H_Broadcast -->|"Provides Folder Structure Information"| C_FolderMap
```
