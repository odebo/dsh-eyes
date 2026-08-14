# dsh-eyes

**给纯文本 DeepSeek 模型长一双眼睛。**

在 dsh Web UI 里直接贴图;`dsh-eyes` 在后台用一个多模态模型把图转成文字描述,再交给你的纯文本模型回答——**不用切模型、不用选任何特殊 provider、不需要额外的 DeepSeek API key**。

## 工作原理(透明)

不注册包装 provider,不要求用户在模型选择器里选任何新东西。用户继续用平时的文本模型(如 `tongyi/deepseek-v4-pro`)。`dsh-eyes` 监听 `agent/pre-step` 瀑布:

1. 当这一步的消息里有图片块时,读图片字节(dsh attachment 服务)。
2. 用配置的多模态模型(默认 `tongyi/qwen3.7-plus`,mify 的 Anthropic 路径)描述图片。
3. 把图片块替换成 `[image] <描述>` 文字证据块。
4. 改写后的消息就是 agent loop 写入 session 的内容,模型只看到文字。

改写发生在消息进入 session 之前,所以「模型可见 ⟺ 已记录」不变量天然成立,不需要任何 adapter 包装。

## 使用

1. 给文本模型的路由声明图片输入(见下方「前提」)。
2. 在对话里贴图、发送。
3. 文本模型基于图片描述回答——全程无感。

## 前提:让文本模型的路由声明图片输入

贴图要能通过 dsh 的图片准入闸口,文本模型所属的 provider 必须声明 `image` 输入。在 `~/.dsh/settings.yaml` 里给 provider 加 `defaultInput: [text, image]`(mify 示例):

```yaml
llm-pi-ai:
  providers:
    mify-deepseek:
      apiKeyEnv: MIFY_DEEPSEEK_API_KEY
      api: anthropic-messages
      baseURL: https://api.llm.mioffice.cn/anthropic
      defaultInput: [ "text", "image" ]   # ← 让 deepseek-v4-pro 等文本模型也能接收贴图
      models:
        - id: tongyi/deepseek-v4-pro
          name: deepseek-v4-pro
        - id: tongyi/qwen3.7-plus
          name: qwen3.7-plus
          input: [ "text", "image" ]
```

`dsh-eyes` 不替你改 pi-ai 的配置(那是另一个插件的领地),这一步需要用户配置一次。加完之后,`deepseek-v4-pro` 就能接收贴图,而 `dsh-eyes` 会在图到达模型前把它转成文字。

## 配置(视觉服务)

默认值就是 mify 内网端点 + 现有 `MIFY_DEEPSEEK_API_KEY`,开箱即用。要换视觉模型/端点,在 `~/.dsh/settings.yaml` 里覆盖,或在 **设置 → dsh-eyes** 页改:

```yaml
dsh-eyes:
  vision:
    model: tongyi/qwen3.7-plus          # 哪个多模态模型当眼睛
    credential: MIFY_DEEPSEEK_API_KEY   # 密钥引用名(密钥值在「设置 → 模型」里配)
    baseURL: https://api.llm.mioffice.cn/anthropic
```

设置页里的「测试连接」会发一张真图给视觉模型,验证它真的能看图。

## 说明

- 复用现有 mify 凭据,不新建 key。
- 按附件缓存:同一张图在多步里只描述一次。
- 视觉失败内联提示(`[image: vision failed — <reason>]`),不中断本轮。
- 像素级 UI 分析、坐标定位、截图 diff 请用 `dsh-vision-toolkit`;`dsh-eyes` 只做对话式「这图是啥」。
- 极小图(1×1/2×2 像素)可能被视觉网关拒;用真实截图和照片。

## 安装(local link)

挂进 dsh web profile(`~/.dsh/profiles/web/package.json`):

```json
"dependencies": { "dsh-eyes": "link:/Users/zhuqichen/MySpace/dsh-eyes" },
"dsh": { "profile": { "bundles": [ "...", "dsh-eyes" ] } }
```

然后 `cd ~/.dsh/profiles/web && pnpm install --no-frozen-lockfile` 并重启 `dsh web`。

License: MIT
