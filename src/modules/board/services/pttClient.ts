import axios from "axios";

const PTT_BASE_URL = "https://www.ptt.cc";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:42.0) Gecko/20100101 Firefox/42.0";

export const pttClient = axios.create({
  baseURL: PTT_BASE_URL,
  headers: {
    "User-Agent": USER_AGENT,
    Cookie: "over18=1",
  },
  timeout: 10000,
});

export { PTT_BASE_URL };
