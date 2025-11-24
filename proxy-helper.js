/* proxy-helper.js */
const ProxyAgent = require('proxy-agent');
const axios = require('axios');

function getAxiosOptionsFromEnv(timeout = 30000) {
  const proxyUrl = process.env.PROXY_URL || null;
  const opts = { timeout };

  if (proxyUrl && proxyUrl.trim().length > 0) {
    try {
      const agent = new ProxyAgent(proxyUrl);
      opts.httpAgent = agent;
      opts.httpsAgent = agent;
      opts.proxy = false;
      opts.maxBodyLength = Infinity;
      opts.maxContentLength = Infinity;
    } catch (err) {
      console.error('proxy-helper: ProxyAgent create error:', err && err.message ? err.message : err);
    }
  }

  return opts;
}

function createAxiosInstance(timeout = 30000) {
  const options = getAxiosOptionsFromEnv(timeout);
  const instance = axios.create(options);
  return instance;
}

module.exports = {
  getAxiosOptionsFromEnv,
  createAxiosInstance
};
