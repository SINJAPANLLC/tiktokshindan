import { Router, type IRouter } from "express";
import healthRouter from "./health";
import diagnoseRouter from "./diagnose";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(diagnoseRouter);
router.use(adminRouter);

export default router;
