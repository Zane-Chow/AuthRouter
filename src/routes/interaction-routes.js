import crypto from 'node:crypto';
import Router from '@koa/router';
import { ForbiddenError, ValidationError } from '../errors.js';

function createFlow(uid, clientId) {
  return {
    uid,
    clientId,
    startedAt: Date.now(),
  };
}

function requireFlow(ctx) {
  const flow = ctx.session?.oidcFlow;
  if (!flow || flow.uid !== ctx.params.uid) {
    throw new ForbiddenError('会话已过期，请返回原网站重新发起 SSO 登录');
  }
  return flow;
}

function clearFlow(ctx) {
  delete ctx.session.oidcFlow;
}

function normalizeProfile(profile, providerId) {
  if (!profile || !profile.id || !profile.email) {
    throw new ValidationError(`${providerId} 未返回可用的用户标识或邮箱`);
  }
  return {
    provider: providerId,
    id: String(profile.id),
    email: String(profile.email).trim().toLowerCase(),
    name: String(profile.name || ''),
    avatar: String(profile.avatar || ''),
  };
}

export function createInteractionRouter({ provider, upstream, mappings, render, logger }) {
  const router = new Router();

  async function redirectToProvider(ctx, providerId, flow) {
    flow.provider = providerId;
    flow.state = crypto.randomBytes(24).toString('base64url');
    flow.nonce = crypto.randomBytes(24).toString('base64url');
    ctx.session.oidcFlow = flow;
    const url = await upstream.getAuthUrl(providerId, flow.state, flow.nonce, flow.clientId);
    logger.info('redirecting to upstream provider', { uid: flow.uid, providerId });
    ctx.redirect(url);
  }

  router.get('/interaction/:uid', async (ctx) => {
    const details = await provider.interactionDetails(ctx.req, ctx.res);
    const { prompt } = details;

    if (prompt.name === 'login') {
      const clientId = details.params.client_id;
      const providers = await upstream.getEnabledProviders(clientId);
      if (providers.length === 0) {
        await render(ctx, 'error', {
          message: '该客户端没有可用的上游身份提供商',
          hint: '请联系管理员检查此客户端的上游权限和 IdP 启用状态。',
        });
        return;
      }

      const flow = createFlow(ctx.params.uid, clientId);
      ctx.session.oidcFlow = flow;
      if (providers.length === 1) {
        await redirectToProvider(ctx, providers[0].id, flow);
        return;
      }

      await render(ctx, 'login-selector', { uid: ctx.params.uid, providers });
      return;
    }

    if (prompt.name === 'consent') {
      let grant = details.grantId
        ? await provider.Grant.find(details.grantId)
        : new provider.Grant({ accountId: details.session.accountId, clientId: details.params.client_id });

      if (prompt.details.missingOIDCScope) grant.addOIDCScope(prompt.details.missingOIDCScope.join(' '));
      if (prompt.details.missingOIDCClaims) grant.addOIDCClaims(prompt.details.missingOIDCClaims);
      for (const [indicator, scopes] of Object.entries(prompt.details.missingResourceScopes || {})) {
        grant.addResourceScope(indicator, scopes.join(' '));
      }

      const grantId = await grant.save();
      await provider.interactionFinished(
        ctx.req,
        ctx.res,
        { consent: { grantId } },
        { mergeWithLastSubmission: true },
      );
      return;
    }

    throw new ValidationError(`不支持的交互类型: ${prompt.name}`);
  });

  router.post('/interaction/:uid/select-idp', async (ctx) => {
    const flow = requireFlow(ctx);
    const providerId = String(ctx.request.body.provider || '');
    if (!providerId || !(await upstream.isProviderAllowedForClient(providerId, flow.clientId))) {
      throw new ValidationError(`不支持的登录方式: ${providerId}`);
    }
    await redirectToProvider(ctx, providerId, flow);
  });

  router.get('/sso/:provider/callback', async (ctx) => {
    const flow = ctx.session?.oidcFlow;
    const providerId = ctx.params.provider;
    if (!flow || !flow.uid) throw new ForbiddenError('会话已过期，请返回原网站重新发起 SSO 登录');
    if (flow.provider !== providerId) throw new ForbiddenError('上游身份提供商与当前登录会话不匹配');
    if (!(await upstream.isProviderAllowedForClient(providerId, flow.clientId))) {
      throw new ValidationError(`不支持的登录方式: ${providerId}`);
    }

    const profile = await upstream.handleCallback(providerId, ctx, {
      oauth_state: flow.state,
      oauth_nonce: flow.nonce,
    }, flow.clientId);
    flow.profile = normalizeProfile(profile, providerId);
    ctx.session.oidcFlow = flow;
    logger.info('upstream authentication completed', { providerId, subject: flow.profile.id });
    ctx.redirect(`/interaction/${encodeURIComponent(flow.uid)}/federated`);
  });

  router.get('/interaction/:uid/federated', async (ctx) => {
    const flow = requireFlow(ctx);
    if (!flow.profile || !flow.clientId) throw new ForbiddenError('认证信息丢失，请重新登录');
    const profile = flow.profile;
    if (!(await upstream.isProviderAllowedForClient(profile.provider, flow.clientId))) {
      throw new ForbiddenError('该客户端已无权使用此上游身份提供商');
    }
    const accounts = await mappings.getTargetAccounts(flow.clientId, profile.provider, profile.email);

    if (accounts.length <= 1) {
      const accountId = accounts[0]?.target_identity || profile.email;
      await provider.interactionFinished(
        ctx.req,
        ctx.res,
        { login: { accountId, remember: false } },
        { mergeWithLastSubmission: false },
      );
      clearFlow(ctx);
      return;
    }

    await render(ctx, 'select-account', {
      uid: ctx.params.uid,
      userEmail: profile.email,
      userName: profile.name,
      userAvatar: profile.avatar,
      providerName: profile.provider,
      accounts,
    });
  });

  router.post('/interaction/:uid/select', async (ctx) => {
    const flow = requireFlow(ctx);
    const selectedAccount = String(ctx.request.body.selected_account || '').trim().toLowerCase();
    if (!flow.profile || !selectedAccount) throw new ValidationError('无效的账号选择请求');
    if (!(await upstream.isProviderAllowedForClient(flow.profile.provider, flow.clientId))) {
      throw new ForbiddenError('该客户端已无权使用此上游身份提供商');
    }

    const accounts = await mappings.getTargetAccounts(flow.clientId, flow.profile.provider, flow.profile.email);
    if (!accounts.some((account) => account.target_identity === selectedAccount)) {
      throw new ForbiddenError('所选账号未与当前登录身份关联');
    }

    await provider.interactionFinished(
      ctx.req,
      ctx.res,
      { login: { accountId: selectedAccount, remember: false } },
      { mergeWithLastSubmission: false },
    );
    clearFlow(ctx);
  });

  return router;
}
