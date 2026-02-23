import https from "node:https";

import axios from "axios";
import axiosRetry from "axios-retry";

const PTT_BASE_URL = "https://www.ptt.cc";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:42.0) Gecko/20100101 Firefox/42.0";

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
});

export const pttClient = axios.create({
  baseURL: PTT_BASE_URL,
  headers: {
    "User-Agent": USER_AGENT,
    Cookie: "over18=1",
  },
  timeout: 10000,
  httpsAgent,
});

axiosRetry(pttClient, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    if (axiosRetry.isNetworkOrIdempotentRequestError(error)) return true;
    const status = error.response?.status;
    return status !== undefined && status >= 500;
  },
});

export { PTT_BASE_URL };
