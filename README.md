# pi-agy-bridge

Standalone AGY provider and Pi capability bridge extension for Pi (`@earendil-works/pi-coding-agent`).

讓 Pi 可以將 AGY 作為 LLM Provider，並透過本機 MCP 與 IPC Socket 機制將 Pi 的原生工具（`read`, `edit`, `bash` 等）雙向橋接給 AGY 執行。

---

## 使用方式

### 1. 安裝與載入套件

在 Pi 專案中新增依賴：

```json
{
  "dependencies": {
    "pi-agy-bridge": "^0.1.2"
  }
}
```

或在 Pi 設定檔（如 `pi.json` 或 `settings.json`）中載入擴充套件：

```json
{
  "extensions": ["pi-agy-bridge"]
}
```

### 2. 在程式中設定與客製化

若是自訂 Pi Agent 啟動腳本，可透過 `setupAgyProvider` 進行自訂配置：

```typescript
import { setupAgyProvider } from "pi-agy-bridge";

setupAgyProvider(pi, {
  agyPath: "agy",            // agy 執行檔路徑（預設: "agy"）
  minVersion: "1.1.15",      // 最低相容 AGY 版本要求
  agentName: "pi-bridge",    // AGY 內部使用的 bridge agent 名稱
  pluginDir: "./plugin",     // 自訂 plugin 目錄（選填）
  debug: false               // 是否開啟詳細除錯日誌
});
```

### 3. 切換 Provider 與 Model

載入擴充後，Pi 內會註冊 `agy` provider。模型清單會先同步載入上次成功 discovery 的快取（`~/.pi/agent/cache/agy-models.json`），並在背景透過 `agy models` 更新；刷新完成後會更新當前清單和快取。首次使用且尚無快取時，模型會在背景 discovery 完成後出現。若 AGY 不存在或刷新失敗，既有快取會保留；重新開啟 `/model` 不會等待 discovery。

Pi 的 `~/.pi/agent/models.json` 會在 discovery 結果之上套用 `modelOverrides`。例如：

```json
{
  "providers": {
    "agy": {
      "modelOverrides": {
        "gemini-3.8-flash": {
          "name": "Gemini Flash via AGY",
          "maxTokens": 32768
        }
      }
    }
  }
}
```

若透過 `setupAgyProvider(pi, { models: [...] })` 明確提供 models，則使用該清單並停用自動 discovery；Pi 的 `modelOverrides` 仍會套用。

### 4. 除錯環境變數

可透過環境變數啟用詳細診斷資訊：

```bash
export AGY_BRIDGE_DEBUG=1
```

診斷輸出會以 `[agy:<scope>]` 前綴寫入 stderr（例如 `mcp`、`session`、`process`、`register`）。

---

## 架構與橋接方式

`pi-agy-bridge` 的核心運作機制如下：

```text
┌─────────────────┐       Unix Domain Socket       ┌─────────────────┐
│   Pi Harness    │◄──────────────────────────────►│    AGY CLI      │
│ (Event Adapter) │        MCP Protocol            │ (pi-bridge agent│
└────────┬────────┘                                └────────┬────────┘
         │                                                  │
    Native Tools                                      call_mcp_tool
(read, edit, bash...)                              (Pi Tools via MCP)
```

1. **Provider 註冊與 Context 轉換**：
   - 在 Pi 註冊 `agy` provider，攔截串流請求（`streamSimple`）。
   - 將 Pi 的對話訊息格式化，並根據對話歷史判斷是全新啟動、接續（continue）或是還原 session（resume）。
2. **動態 IPC MCP 伺服器 (`BridgeIPC`)**：
   - 每個 Pi session 啟動時會在隨機產生的 Unix domain socket 上啟動 MCP 伺服器。
   - 將 Pi 目前活躍的原生工具（Schema、名稱、參數）暴露至 MCP server（伺服器名稱為 `pi-agy-bridge_pi`）。
3. **AGY 子程序執行**：
   - 透過子程序啟動 `agy`，指定 `--agent pi-bridge` 並以環境變數傳遞 socket 位址。
   - 啟動時會自動確保 `~/.gemini/config/plugins/pi-agy-bridge` 靜態 agent 與設定已安裝並同步。
4. **雙向工具轉發（Tool Relaying）**：
   - 當 AGY 需要使用工具時，會透過 MCP 呼叫 `call_mcp_tool`。
   - Bridge 接收到呼叫後轉發給 Pi 原生 Tool Execution Pipeline，並在取得結果後透過 socket 回傳給 AGY。
   - AGY 產生的事件（文字 delta、工具呼叫狀態、思考過程）即時透過 `PiEventAdapter` 轉回 Pi 的串流介面。

---

## 使用限制

1. **系統平台限制**：
   - MCP 與 IPC 連線依賴 Unix domain sockets，目前僅支援 **macOS** 與 **Linux** 環境（或支援 Unix sockets 的 POSIX 相容環境）。
   - 在禁止或隔離 Unix domain socket 的嚴格沙盒環境中，本機 MCP 連線將無法建立。
2. **環境前置需求**：
   - Node.js >= 20
   - AGY CLI >= 1.1.15，且必須可在 `$PATH` 中找到（或透過 `agyPath` 明確指定路徑）。
   - `@earendil-works/pi-coding-agent` >= 0.87.1
3. **Plugin 同步目錄權限**：
   - 擴充套件初次執行或版本更新時，需要寫入權限以同步 bridge plugin 至 `~/.gemini/config/plugins/pi-agy-bridge`。
4. **工具相容性**：
   - 僅支援由 Pi 註冊並明確宣告 Schema 的工具；AGY 原生內建的非 Pi 工具（除必要 internal dispatchers 外）在橋接模式下會被攔截阻擋，以確保執行行為完全由 Pi 的安全策略受控。

---

## 開發指南

```bash
# 執行型別檢查
npm run typecheck

# 執行單元測試
npm test
```

---

## License

MIT
