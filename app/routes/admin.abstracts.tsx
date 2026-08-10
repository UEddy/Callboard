import { useLoaderData } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { getDb } from "~/db/client";
import { loadSubmissionList, setSubmissionStatus } from "~/lib/submission-list";
import { SubmissionsList } from "~/components/SubmissionsList";

export async function loader({ context, request }: LoaderFunctionArgs) {
  return loadSubmissionList(getDb(context), request, "abstracts");
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

export default function Abstracts() {
  return (
    <SubmissionsList
      data={useLoaderData<typeof loader>()}
      title="Abstracts"
      blurb="Early stage ideas submitted as abstracts. Same tabs, search and filters as the full list."
      basePath="/admin/abstracts"
    />
  );
}
