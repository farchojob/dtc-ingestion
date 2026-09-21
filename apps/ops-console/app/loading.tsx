import { Skeleton } from "@/components/ui/skeleton";
import { Container } from "@/components/console/chrome";

/** Home while the two overview queries run: two card shapes. */
export default function Loading() {
  return (
    <Container className="pb-16 pt-8 md:pt-[52px]">
      <Skeleton className="h-8 w-40 rounded-[6px]" />
      <Skeleton className="mt-4 h-4 w-[520px] max-w-full rounded-[4px]" />
      <div className="mt-10 grid gap-7 md:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-[12px] border border-hairline bg-panel px-9 pb-[34px] pt-8">
            <Skeleton className="h-6 w-32 rounded-[4px]" />
            <Skeleton className="mt-8 h-12 w-64 rounded-[6px]" />
            <Skeleton className="mt-4 h-3 w-48 rounded-[4px]" />
            <div className="my-[30px] h-px bg-hairline" />
            <div className="grid grid-cols-4 gap-[18px]">{[0, 1, 2, 3].map((j) => <Skeleton key={j} className="h-[70px] rounded-[6px]" />)}</div>
            <div className="my-[30px] h-px bg-hairline" />
            <Skeleton className="h-[110px] rounded-[6px]" />
          </div>
        ))}
      </div>
    </Container>
  );
}
