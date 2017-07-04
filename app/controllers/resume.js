import config from 'config';
import Resume from '../models/resumes';
import User from '../models/users';
import ResumePub from '../models/resume-pub';
import ShareAnalyse from '../models/share-analyse';
import getCacheKey from './helper/cacheKey';
import Downloads from '../services/downloads';
import dateHelper from '../utils/date';
import { getGithubSections, getMobileMenu } from './shared';
import Slack from '../services/slack';
import logger from '../utils/logger';

/* ===================== private ===================== */

const URL = config.get('url');

const getResumeShareStatus = (findPubResume, locale) => {
  const { result, success, message } = findPubResume;
  if (!success) {
    return {
      error: message,
      success: true,
      result: null
    };
  }

  const {
    github,
    template,
    useGithub,
    resumeHash,
    openShare,
  } = result;
  return {
    success: true,
    result: {
      github,
      template,
      openShare,
      useGithub,
      resumeHash,
      url: `resume/${resumeHash}?locale=${locale}`,
      githubUrl: null
    }
  };
};

/* ===================== router handler ===================== */

const getResume = async (ctx, next) => {
  const userId = ctx.session.userId;
  const getResult = await Resume.getResume(userId);
  const { message, result } = getResult;
  ctx.body = {
    success: true,
    result
  };
};

const setResume = async (ctx, next) => {
  const { resume } = ctx.request.body;
  const { userId, githubLogin } = ctx.session;

  const setResult = await Resume.updateResume(userId, resume, ctx.cache);
  logger.info(`[RESUME:UPDATE][${githubLogin}]`);
  let resumeInfo = null;
  if (setResult.success) {
    // check & add resume share info
    let checkResult = await ResumePub.findPublicResume({ userId });
    if (!checkResult.success) {
      checkResult = await ResumePub.addPubResume(userId);
    }
    resumeInfo = checkResult.success ? {
      url: `resume/${checkResult.result.resumeHash}?locale=${ctx.session.locale}`,
      useGithub: checkResult.result.useGithub,
      openShare: checkResult.result.openShare
    } : null;
  }

  const checkPubResume = await ResumePub.findPublicResume({ userId });
  if (checkPubResume.success) {
    const hash = checkPubResume.result.resumeHash;
    const cacheKey = getCacheKey(ctx);
    ctx.query.deleteKeys = [
      cacheKey(`resume.${hash}`)
    ];
  }

  Slack.msg({
    type: 'resume',
    data: `Resume create or update by <https://github.com/${githubLogin}|${githubLogin}>`
  });

  ctx.body = {
    success: true,
    message: ctx.__("messages.success.save"),
    result: resumeInfo
  };

  await next();
};

const downloadResume = async (ctx, next) => {
  const { hash } = ctx.query;
  const { userId, githubLogin } = ctx.session;
  const { result } = await ResumePub.getUpdateTime(hash);
  const seconds = dateHelper.getSeconds(result);

  const resumeUrl =
    `${URL}/resume/${hash}?locale=${ctx.session.locale}&userId=${userId}&notrace=true`;
  Slack.msg({
    type: 'download',
    data: `<${resumeUrl}|${githubLogin} resume>`
  });
  logger.info(`[RESUME:DOWNLOAD][${resumeUrl}]`);
  ctx.cache.hincrby('resume', 'download', 1);
  const resultUrl = await Downloads.resume(resumeUrl, {
    folder: githubLogin,
    title: `${seconds}-resume.pdf`
  });

  ctx.body = {
    result: resultUrl,
    success: true
  };
};

const getPubResume = async (ctx, next) => {
  const { hash } = ctx.query;
  const findResume = await ResumePub.getPubResume(hash);
  const { success, result, message } = findResume;

  ctx.body = {
    message,
    result,
    success: true
  };

  await next();
};

const getResumeSharePage = async (ctx, next) => {
  const { userId } = ctx.session;
  const findPubResume = await ResumePub.findPublicResume({ userId });
  const { result, success } = findPubResume;
  if (!success) {
    return ctx.redirect('/404');
  }
  const { resumeHash } = result;

  if (ctx.state.isMobile) {
    return ctx.redirect(`/resume/${resumeHash}/mobile`);
  }
  return ctx.redirect(`/resume/${resumeHash}`);
};

const getPubResumePage = async (ctx, next) => {
  const { hash } = ctx.params;
  const { userName, userLogin } = ctx.query;

  await ctx.render('resume/share', {
    title: ctx.__("resumePage.title", userName),
    resumeHash: hash,
    login: userLogin,
    hideFooter: true
  });
};

const getPubResumePageMobile = async (ctx, next) => {
  const { hash } = ctx.params;
  const { isAdmin, userName, userLogin } = ctx.query;

  await ctx.render('user/mobile/resume', {
    title: ctx.__("resumePage.title", userName),
    resumeHash: hash,
    login: userLogin,
    menu: getMobileMenu(ctx),
    user: {
      isAdmin
    },
    hideFooter: true
  });
};

const getPubResumeStatus = async (ctx, next) => {
  const { hash } = ctx.params;
  const { fromDownload, locale } = ctx.session;
  const findPubResume = await ResumePub.findPublicResume({ resumeHash: hash });
  const shareResult = getResumeShareStatus(findPubResume, locale);

  const { success, result } = shareResult;
  if (success && result && fromDownload) {
    const { userId } = findPubResume.result;
    const user = await User.findUserById(userId);
    shareResult.result.githubUrl =
      `${URL}/github/${user.githubLogin}?locale=${locale}`;
  }

  return ctx.body = shareResult;
};

const getResumeStatus = async (ctx, next) => {
  const { userId, locale } = ctx.session;
  const findPubResume = await ResumePub.findPublicResume({ userId });

  return ctx.body = getResumeShareStatus(findPubResume, locale);
};

const setResumeShareStatus = async (ctx, next) => {
  const { enable } = ctx.request.body;
  const { userId } = ctx.session;
  const findPubResume = await ResumePub.findPublicResume({ userId });
  const { result, success, message } = findPubResume;
  if (!success) {
    return ctx.body = {
      error: message,
      success: true
    };
  }
  await ResumePub.updatePubResume(userId, result.resumeHash, {
    openShare: enable
  });
  const resultMessage = Boolean(enable) == true
    ? "messages.share.toggleOpen"
    : "messages.share.toggleClose";
  ctx.body = {
    success: true,
    message: ctx.__(resultMessage)
  };
};

const setResumeShareTemplate = async (ctx) => {
  const { template } = ctx.request.body;
  const { userId } = ctx.session;
  const findPubResume = await ResumePub.findPublicResume({ userId });
  await ResumePub.updatePubResume(userId, result.resumeHash, {
    template
  });
  ctx.body = {
    success: true,
    message: ctx.__("messages.resume.template")
  };
};

const setResumeGithubStatus = async (ctx, next) => {
  const { enable } = ctx.request.body;
  const { userId } = ctx.session;
  const findPubResume = await ResumePub.findPublicResume({ userId });
  const { result, success, message } = findPubResume;
  if (!success) {
    return ctx.body = {
      error: message,
      success: true
    };
  }
  await ResumePub.updatePubResume(userId, result.resumeHash, {
    useGithub: enable
  });
  const resultMessage = Boolean(enable) == true
    ? "messages.resume.linkGithub"
    : "messages.resume.unlinkGithub";
  ctx.body = {
    success: true,
    message: ctx.__(resultMessage)
  };
};

const setGithubShareSection = async (ctx, next) => {
  const { userId } = ctx.session;
  const findPubResume = await ResumePub.findPublicResume({ userId });
  const { result, success, message } = findPubResume;
  if (!success) {
    return ctx.body = {
      error: message,
      success: true
    };
  }

  const githubSections = getGithubSections(ctx.request.body);

  await ResumePub.updatePubResume(userId, result.resumeHash, {
    github: Object.assign({}, result.github, githubSections)
  });
  ctx.body = {
    success: true
  };
};

const getShareRecords = async (ctx, next) => {
  const { userId } = ctx.session;
  const findPubResume = await ResumePub.findPublicResume({ userId });
  const { result, success, message } = findPubResume;
  if (!success) {
    ctx.body = {
      error: message,
      success: true,
      result: {
        url: '',
        viewDevices: [],
        viewSources: [],
        pageViews: [],
        openShare: false
      }
    };
    return;
  }

  const shareAnalyse =
    await ShareAnalyse.findShare({
      url: `resume/${result.resumeHash}`,
      userId
    });
  const { viewDevices, viewSources, pageViews } = shareAnalyse;
  ctx.body = {
    success: true,
    result: {
      url: `resume/${result.resumeHash}?locale=${ctx.session.locale}`,
      openShare: result.openShare,
      viewDevices,
      viewSources,
      pageViews,
    }
  };
};

export default {
  getResume,
  setResume,
  downloadResume,
  getPubResume,
  getResumeSharePage,
  getPubResumePage,
  getPubResumePageMobile,
  getResumeStatus,
  getPubResumeStatus,
  setResumeShareStatus,
  setResumeShareTemplate,
  setResumeGithubStatus,
  setGithubShareSection,
  getShareRecords
};
