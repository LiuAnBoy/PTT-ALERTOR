import { pttClient } from "../../board/services/pttClient";

/**
 * Regex to extract the canonical board name from PTT article links.
 * Matches patterns like /bbs/Stock/M. in the HTML response.
 */
const BOARD_NAME_RE = /\/bbs\/([A-Za-z][\w-]*)\/M\./;

/**
 * Validate if a PTT board exists and resolve its canonical name.
 * PTT URLs are case-insensitive, so we extract the correct name from the response HTML.
 * @param boardName - The board name to validate (any casing).
 * @returns The canonical board name, or null if the board does not exist.
 */
export async function resolveBoard(boardName: string): Promise<string | null> {
  try {
    const res = await pttClient.get(`/bbs/${boardName}/index.html`);
    if (res.status !== 200) return null;

    const match = BOARD_NAME_RE.exec(res.data as string);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
