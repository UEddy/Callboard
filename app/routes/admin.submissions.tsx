import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { getDb } from "~/db/client";
import { loadSubmissionList, setSubmissionStatus } from "~/lib/submission-list";
import { SubmissionsList } from "~/components/SubmissionsList";

export async function loader({ context, request }: LoaderFunctionArgs) {
  return loadSubmissionList(getDb(context), request, null);
}

export async function action({ context, request }: ActionFunctionArgs) {
  const fd = await request.formData();
  if (String(fd.get("intent")) !== "set_status") return { ok: false };
  return setSubmissionStatus(
    getDb(context),
    String(fd.get("submissionId")),
    String(fd.get("status")),
  );
}

export default function Submissions() {
  return (
    <SubmissionsList
      data={useLoaderData<typeof loader>()}
      title="Submissions"
      blurb="Everything submitted to this event. Decisions stage in a queue before anything is sent."
      source="submissions"
      basePath="/admin/submissions"
    />
  );
}
