// Public, unauthenticated reads the web and mobile apps fetch: the announcement banner and the services offered
// (platform settings, lib/settings.ts). Read only; covered by the global rate limit; cached for a minute.
import express from "express";
import { handlePublicAnnouncement, handlePublicServices } from "../controllers/admin/settings.controller";

const publicRoute = express.Router();

publicRoute.get("/announcement", handlePublicAnnouncement);
publicRoute.get("/services", handlePublicServices);

export default publicRoute;
