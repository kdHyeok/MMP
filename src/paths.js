import { homedir } from "node:os";
import { join } from "node:path";

// MCP, 감시기, 승인 정책은 클라이언트와 무관하게 같은 사용자 저장소를 쓴다.
export function resolveDataDir(explicitPath) {
  if (explicitPath) return explicitPath;
  if (process.env.MATTERMOST_MCP_DATA_DIR) return process.env.MATTERMOST_MCP_DATA_DIR;
  const forwarded = process.env.MATTERMOST_MCP_USERPROFILE;
  return join(forwarded && forwarded !== "__MMP_UNSET__" ? forwarded : homedir(), ".mmp");
}
