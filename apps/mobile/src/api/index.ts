import { useAuth } from "../auth";
export { createApi } from "./create-api";
export const useApi = () => useAuth().api;
