import { Card, CardContent } from "./ui/card";
import { Skeleton } from "./ui/skeleton";

export function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex w-full flex-col gap-4 p-4" aria-busy="true">
      <Skeleton className="h-8 w-2/3 max-w-xs" />
      {Array.from({ length: rows }, (_, i) => `row-${i}`).map((key) => (
        <Card key={key}>
          <CardContent className="flex flex-col gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
