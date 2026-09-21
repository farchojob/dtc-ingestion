import { Container, Notice } from "@/components/console/chrome";

export default function NotFound() {
  return (
    <Container className="py-16">
      <Notice title="No such tenant or view">Tenants are the ones in the top bar; views are deliveries, runs, revenue, restatements and holds.</Notice>
    </Container>
  );
}
