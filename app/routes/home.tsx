import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaArgs,
} from "react-router";
import SignIn, {
  action as signInAction,
  loader as signInLoader,
  meta as signInMeta,
} from "./admin.sign-in";

/* ------------------------------------------------------------------ *
 * The root is the sign-in page.
 *
 * Not a redirect to it: a redirect costs a round trip and leaves the
 * bare domain looking like it points somewhere else. This route shares
 * the sign-in module outright, so / and /admin/sign-in render the same
 * page, accept the same form and redeem the same magic link.
 *
 * Written as real declarations rather than `export { action } from`,
 * because the route module analysis that decides whether a route can
 * handle a POST does not follow re-exports: with them, / rendered
 * correctly and then answered 405 to its own form.
 * ------------------------------------------------------------------ */

export async function loader(args: LoaderFunctionArgs) {
  return signInLoader(args);
}

export async function action(args: ActionFunctionArgs) {
  return signInAction(args);
}

export function meta(args: MetaArgs) {
  return signInMeta(args);
}

export default function Home() {
  return <SignIn />;
}
