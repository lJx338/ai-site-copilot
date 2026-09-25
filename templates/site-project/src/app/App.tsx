import SiteLayout from "../layouts/SiteLayout";
import { useRouter } from "./router";
import ContactPage from "../pages/ContactPage";
import HomePage from "../pages/HomePage";
import MenuPage from "../pages/MenuPage";
import NotFoundPage from "../pages/NotFoundPage";
import ReservationPage from "../pages/ReservationPage";
import StoresPage from "../pages/StoresPage";

export default function App() {
  const { path } = useRouter();
  const page = path === "/" ? <HomePage /> : path === "/menu" ? <MenuPage /> : path === "/stores" ? <StoresPage /> : path === "/reservation" ? <ReservationPage /> : path === "/contact" ? <ContactPage /> : <NotFoundPage />;
  return <SiteLayout>{page}</SiteLayout>;
}
