import { Skeleton } from "@/components/ui/skeleton";
import { Container } from "@/components/console/chrome";

/** A tenant view while its query runs: the title row, the sub nav, then a table shape (34px head + rows of 44). */
export default function Loading() {
  return (
    <>
      <Container className="pt-8 md:pt-11">
        <div className="flex items-baseline gap-4">
          <Skeleton className="h-8 w-44 rounded-[6px]" />
          <Skeleton className="h-5 w-12 rounded-[4px]" />
          <div className="grow" />
          <Skeleton className="h-4 w-40 rounded-[4px]" />
        </div>
        <Skeleton className="mt-4 h-4 w-[640px] max-w-full rounded-[4px]" />
        <div className="mt-7 flex gap-8 border-b border-hairline pb-[14px]">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-4 w-20 rounded-[4px]" />)}</div>
      </Container>
      <Container className="pb-16 pt-10">
        <div className="overflow-hidden rounded-[10px] border border-hairline bg-panel">
          <div className="h-[34px] border-b border-hairline-2 bg-row-hover" />
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex h-[44px] items-center gap-6 border-b border-hairline px-[18px] last:border-b-0">
              <Skeleton className="h-3 w-24 rounded-[3px]" /><Skeleton className="h-3 w-16 rounded-[3px]" /><Skeleton className="h-3 w-40 rounded-[3px]" />
              <div className="grow" /><Skeleton className="h-3 w-20 rounded-[3px]" />
            </div>
          ))}
        </div>
      </Container>
    </>
  );
}
