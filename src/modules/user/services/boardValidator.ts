import { pttClient } from "../../board/services/pttClient";

/**
 * Validate if a PTT board exists by checking the HTTP response.
 * @param boardName - The board name to validate.
 * @returns True if the board exists.
 */
export async function boardExists(boardName: string): Promise<boolean> {
  try {
    const res = await pttClient.get(`/bbs/${boardName}/index.html`);
    return res.status === 200;
  } catch {
    return false;
  }
}
