import { DataStamp } from "@/components/refresh-control";

/**
 * Server component: stamps the time this page's data was read, for the
 * header's "as of" readout. Rendered by each data page, so the stamp travels
 * with the page's server payload - a Back/Forward served from the router
 * cache brings its original, older stamp back with it, and a refresh only
 * moves the stamp once the new payload has actually arrived.
 */
export function LoadedAt() {
  // Request time on a force-dynamic server render, which is the point.
  // eslint-disable-next-line react-hooks/purity
  return <DataStamp at={Date.now()} />;
}
