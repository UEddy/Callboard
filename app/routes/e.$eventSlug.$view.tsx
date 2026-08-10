/* Each public view has a standalone URL: /e/:eventSlug/sessions and so
   on. Same module as the bare /e/:eventSlug route, so there is one
   implementation and the path simply selects the view. */
export {
  loader,
  headers,
  meta,
  default,
} from "./e.$eventSlug";
