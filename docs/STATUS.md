# CPwebsite Status

## 2026-11-23 生产站与正式收款

- 生产站已开放浏览、账户和购物篮。PR #32 已部署，包含批量确认送达、结账邮箱、订单邮件和后台文案更新。注册验证与密码重置模板已在生产 Supabase 保存并重新核对。
- 上线文案清理移除后台全局订单徽章、页面搜索摘要的设计预览字样和浏览器预置优惠券。模拟记录的订单详情、邮件和业务营收仍明确显示实情。
- 生产目录及优惠券按常见验收标识检查，未发现已发布的候选商品或已启用的候选优惠券。原有库存、订单和审计记录保留。

## 正式收款切换

- 正式支付代码、付款回跳、配送地址快照和收件人隔离进入发布准备。部署配置继续使用受控的模拟结账，公开结账关闭。
- 商户需在 Stripe 正式账户完成商户验证并设置收款账户。核对收款和打款能力后，在 Cloudflare Worker 受保护配置中使用正式 API 密钥及 webhook 签名密钥。不要在聊天、源码或构建日志中复制凭据。
- 正式 webhook 路由为 `https://cpvaluemart.com/api/stripe/webhook`，接收 `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`checkout.session.async_payment_failed`、`checkout.session.expired`。先核对现有模拟未结订单，处理完成或确认其过期后再更换凭据。
- 更换凭据后先将 Worker 设为 `live-pilot`，仅管理员可发起正式结账。用获准的低额订单验证实收、签名回调、库存、邮件实际送达、退款和必要的库存恢复。核对账务和运营后将 `STRIPE_CHECKOUT_MODE` 改为 `live`。
- 正式试单一旦创建，关闭公开结账时退回 `live-pilot`，保留正式 webhook 和凭据以处理已有付款和退款。切换前的模拟数据应保留以供审计。

[Stripe 上线清单](https://docs.stripe.com/get-started/checklist/go-live)

旧阶段的验收与证据见 [final-acceptance.md](final-acceptance.md)。
