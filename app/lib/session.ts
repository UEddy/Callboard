import { createCookie } from "react-router";

export const submitSession = createCookie("cb_submit", {
  path: "/",
  httpOnly: true,
  sameSite: "lax",
  maxAge: 60 * 60 * 24 * 30,
  secrets: ["callboard-dev-secret-change-me"],
});

export type SubmitSession = {
  participantId?: string;
  submissionId?: string;
};

export async function readSession(request: Request): Promise<SubmitSession> {
  const parsed = await submitSession.parse(request.headers.get("Cookie"));
  return (parsed as SubmitSession) ?? {};
}

export async function writeSession(data: SubmitSession) {
  return await submitSession.serialize(data);
}