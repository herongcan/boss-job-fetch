# 隐私权政策 · Privacy Policy

**boss-job-fetch**
最后更新：2026-11-17 / Last updated: 2026-11-17

## 中文

### 一、我们不收集任何数据

本扩展不收集、不上传、不共享任何个人信息。所有数据仅保存在你本机的浏览器存储（`chrome.storage.local`）中，开发者无法访问，也没有任何服务器接收这些数据。

### 二、本地保存了什么

你在 BOSS 直聘（zhipin.com）浏览岗位时，扩展会把以下内容记录到本地：

- 岗位信息：岗位 ID、标题、薪资、公司、城市、经验、学历、技能标签、行业、公司规模、岗位描述正文、详情页链接
- 采集状态：数据来源、抓取失败次数、失败原因码、首次采集与最后更新时间
- 一项本地设置：是否开启「打开 BOSS 页面时自动补全」

这些数据只用于在扩展弹窗与数据页中展示、导出，以及后续增量补全。

### 三、数据会离开你的设备吗

不会。本扩展没有后端服务，不调用任何第三方 API，不做统计埋点，不投放广告，不包含远程代码。导出的 JSON / CSV 文件由你自己选择保存位置。

### 四、权限用途

| 权限 | 用途 |
|---|---|
| `storage` | 在本机保存采集到的岗位数据与设置 |
| `scripting` | 仅在你点击「快速提取」时，向当前 zhipin.com 页面注入一段只读脚本，用于兜底读取页面已渲染的岗位卡片 |
| 主机权限 `https://www.zhipin.com/*` | 在该站点读取岗位列表数据、请求岗位详情页以补全岗位描述 |

### 五、删除数据

在扩展弹窗点击「清空全部数据」，或在数据页点击「清空」，即可删除全部本地记录。卸载扩展也会一并清除。

### 六、联系方式

如有疑问，请在项目仓库提交 Issue：<https://github.com/herongcan/boss-job-fetch/issues>

---

## English

### 1. No data collection

This extension does not collect, transmit, or share any personal information. All data stays in the
user's own browser storage (`chrome.storage.local`). The developer has no access to it, and no server
receives it.

### 2. What is stored locally

While the user browses job listings on BOSS Zhipin (zhipin.com), the extension records: job id, title,
salary, company, location, experience, education, skill tags, industry, company size, job description
text, job detail URL, along with fetch-status metadata (source, retry count, error code, timestamps)
and one local preference (whether auto-backfill is enabled).

### 3. No transfer off the device

There is no backend service, no third-party API call, no analytics, no advertising, and no remote
code. Exported JSON/CSV files are saved wherever the user chooses.

### 4. Permissions

- `storage` — save collected job records and the setting on the local device.
- `scripting` — only after the user clicks "Quick extract", inject a small read-only function into the
  current zhipin.com page to read job cards already rendered there.
- Host permission `https://www.zhipin.com/*` — read job list data on that site and request job detail
  pages to fill in the full job description.

### 5. Deleting data

Use "Clear all data" in the popup or "Clear" on the data page; uninstalling the extension also removes
all of it.

### 6. Contact

<https://github.com/herongcan/boss-job-fetch/issues>
