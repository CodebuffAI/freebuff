# Freebuff

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文（台灣）](./README.zh-TW.md) | 繁體中文（香港）

**五款免費 AI 產品，涵蓋編寫程式碼、建置與研究。** 無需訂閱、點數或 API 金鑰。

[Freebuff](https://freebuff.com) 將專業化的智能體與多種頂尖模型帶到你的終端機、桌面、瀏覽器和 GitHub 儲存庫。內建模型的存取由文字廣告支援。

## 選擇適合你的 Freebuff

| 產品 | 功能 | 開始使用 |
| --- | --- | --- |
| **Freebuff Desktop** | 在本地並行執行多個智能體 | [下載 macOS、Windows 或 Linux 版](https://freebuff.com/desktop) |
| **Freebuff CLI** | 從終端機編寫程式碼 | [安裝 CLI](https://freebuff.com/cli) |
| **Freebuff Web** | 建置並發佈全端應用程式 | [建置應用程式](https://freebuff.com/web) |
| **Freebuff Cloud** | 在任意 GitHub 儲存庫執行智能體 | [連接儲存庫](https://freebuff.com/cloud) |
| **Freebuff Chat** | 使用 AI 進行研究與思考 | [開始對話](https://freebuff.com/chat) |

## 快速開始

在任意專案中從終端機執行 Freebuff：

```bash
npm install -g freebuff
cd ~/my-project
freebuff
```

然後描述你想完成的工作。Freebuff 會找出相關檔案、進行修改，並執行對你的專案重要的檢查。

## 模型

Freebuff 提供精選的模型目錄。目前的模型選擇器提供：

| 模型 | 存取方式 | 適用場景 |
| --- | --- | --- |
| **GLM 5.3 Flash** | 完整與受限存取 | 各處的預設模型；推理最深入，不消耗會話 |
| **DeepSeek V4 Flash 07/31** | 完整與受限存取 | 快速編寫程式碼與工具使用，不消耗會話 |
| **GPT-5.6 Luna** | 完整存取 | 全能表現，原生支援影像 |
| **MiMo 2.5** | 完整與受限存取 | 均衡效能，支援影像 |
| **Solar Pro 4** | 完整與受限存取 | 限時試用；524K 上下文，僅限文字；完整存取下不消耗會話 |
| **Muse Spark 1.3** | 完整存取 | Meta 的智能體編碼模型；100 萬上下文。有速率限制且由所有用戶共享，繁忙時會排隊，並改由 DeepSeek V4 Flash 回答，不會讓你久候 |

大多數模型使用你平常的每日會話，而非個別設限。GLM 5.3 Flash、DeepSeek V4 Flash 07/31、MiMo 2.5 和 Solar Pro 4 在完整存取下無限量使用，完全不消耗會話。模型仍可能由量化（Q8_0）版本提供服務。

DeepSeek V4 Pro 已從目錄中下線，由 GLM 5.3 Flash 接替成為深度推理的選擇。

一般模型選擇器之外：

- **推薦好友與懸賞任務**可在每日免費額度之外賺取額外會話。
- **Gemini 3.1 Flash Lite** 負責檔案查找和研究等專業任務，不會出現在主模型選擇器中。

可用性與限制取決於你的存取等級、所用產品及目前容量。Freebuff Desktop 也可以使用你現有的提供者帳戶來執行本地安裝的 Claude Code 和 Codex 智能體；這些連接的模型與 Freebuff 內建的模型目錄各自獨立。

## Freebuff 的運作方式

Freebuff 使用專業化的智能體，而不是把所有任務都交給同一個模型和同一條提示詞。視任務而定，智能體會收集上下文、制定計畫、編輯或研究、執行工具，並審查結果。

- **程式碼庫上下文** —— 檔案查找智能體會在編輯前定位專案中的相關部分。
- **實作與審查** —— 智能體可以分工、修改檔案、執行命令並檢查結果。
- **研究與瀏覽器操作** —— 智能體可以查閱文件，並在真實瀏覽器中測試應用程式。
- **本地並行工作** —— Desktop 將並行的智能體隔離在各自的工作區中。
- **託管環境** —— Web 和 Cloud 提供沙盒、預覽、終端機和部署工作流程。

## 免費存取

Freebuff 在所有國家與地區皆可使用。受支援的地區可獲得完整存取；其他地區與 VPN 用戶可獲得對 DeepSeek V4 Flash 07/31、GLM 5.3 Flash、MiMo 2.5 和 Solar Pro 4 的受限存取。使用 Freebucks 的帳戶按顯示的模型價格與餘額計費。在舊版會話系統中，受限存取每天包含六個一小時的會話，最多可累積至七個；GLM 則改用賺取的獎勵會話。

內建模型由文字廣告支援。開始之前，Freebuff 會顯示適用的會話限制以及任何模型特定的資料使用通知。

<!-- BEGIN GENERATED FREEBUFF DATA USE -->

**我的資料會用於 AI 訓練嗎？** 只有當模型或功能表明資料可能用於 AI 訓練時才會。屆時，Freebuff 或提供者可能保留提交的內容，用於開發、訓練、測試、評估、微調及改進 AI 模型或產品。

**我的資料會如何使用和儲存？** 我們會使用提示詞、訊息、智能體軌跡、程式碼、檔案與儲存庫資料來提供 Freebuff 服務。我們可能分析提示詞和訊息以個人化廣告。我們不會將單獨上傳的檔案或已連接的儲存庫提供給廣告提供者。受限制的合作夥伴可能評估已連接的 Cloud 儲存庫或標示為「May use data for AI training」（資料可能用於 AI 訓練）的模型所使用的程式碼，但除此之外不得使用、廣泛分享或以其進行訓練。關於保留期限、資格與廣告選項，請參閱隱私政策。

完整詳情請參閱[隱私政策](https://freebuff.com/privacy-policy)。

<!-- END GENERATED FREEBUFF DATA USE -->

## 參與貢獻

Freebuff 是一個使用 Bun 建置的 TypeScript monorepo。歡迎為產品、智能體、工具、文件和底層執行階段貢獻。

本地開發需要 Docker 和已設定的 `.env.local`；啟動服務之前請先參閱[貢獻指南](./CONTRIBUTING.md)。

```bash
git clone https://github.com/CodebuffAI/freebuff.git
cd freebuff
bun install
bun up
```

也可以另外單獨啟動 CLI：

```bash
bun start-cli
```

環境設定及開啟 pull request 前應執行的檢查，請參閱[貢獻指南](./CONTRIBUTING.md)、[開發指南](./docs/development.md)和[測試指南](./docs/testing.md)。

## 基於 Codebuff 建置

Freebuff 基於開放式多智能體框架 [Codebuff](https://codebuff.com) 建置，其編排、工具和 SDK 皆由 Codebuff 提供。若要建立自訂智能體或將其嵌入其他應用程式，請參閱 [Codebuff 文件](https://codebuff.com/docs)和 [`@codebuff/sdk`](https://www.npmjs.com/package/@codebuff/sdk)。

## 連結

- [官方網站](https://freebuff.com)
- [GitHub](https://github.com/CodebuffAI/freebuff)
- [Discord](https://discord.gg/yXG3w7wxfs)
- [隱私政策](https://freebuff.com/privacy-policy)
- [授權條款](./LICENSE)