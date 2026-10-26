# 实现与参考来源

拾页的扩展读取器、校验器、后台任务、存储、整理器和界面源码均随本仓库公开。运行时使用浏览器原生 API 和本地 JavaScript / CSS，没有远程脚本或打包后的隐藏依赖。工具栏图标由 `build_icons.py` 绘制，内联界面图标也在源码中。

适配网页内部接口时参考过下列公开实现的请求形式与响应字段；它们不是平台官方的稳定接口承诺，也不表示这些项目或平台为拾页背书：

- Claude：[agarwalvishal/claude-chat-exporter](https://github.com/agarwalvishal/claude-chat-exporter)。
- DeepSeek：[Liuxd-1230/deepseek-archive](https://github.com/Liuxd-1230/deepseek-archive)。
- Gemini：[OTLFrostA/gemini-exporter](https://github.com/OTLFrostA/gemini-exporter)，研究时核对的提交为 `a9c4805625f0b86aa6bd63a00c532b89ee5be776`。
- 浏览器 API：[Chrome Extensions](https://developer.chrome.com/docs/extensions/) 与 [Microsoft Edge extensions](https://learn.microsoft.com/en-us/microsoft-edge/extensions/)。

上述第三方项目及下载的网页模块没有作为依赖复制进本仓库。可选的图标再生成工具使用 [Pillow](https://python-pillow.github.io/)，需要使用者另行安装；插件运行和常规测试不依赖 Pillow。

本项目在开发中使用了 AI 辅助编程。公开的测试和代码可用于自行检查行为；本地样本验收不能代替所有平台、版本和聊天类型的验证。项目原始源码按根目录 MIT 许可证开放，平台名称、商标及用户聊天内容不因此获得重新授权。
