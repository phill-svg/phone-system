jest.mock("expo-secure-store");
import * as SecureStore from "expo-secure-store";
import { getToken, setToken, clearToken } from "../src/lib/session";

describe("session token store", () => {
  beforeEach(() => jest.clearAllMocks());

  it("setToken writes to secure store under the token key", async () => {
    await setToken("abc.def");
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("tcb_session_token", "abc.def");
  });
  it("getToken reads from secure store", async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue("abc.def");
    expect(await getToken()).toBe("abc.def");
  });
  it("clearToken deletes the key", async () => {
    await clearToken();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("tcb_session_token");
  });
});
