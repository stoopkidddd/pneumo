package dev.pneumo.app.net

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient

class ApiClient private constructor(context: ApiContext) :
    AccountApi by AccountApiClient(context),
    DeviceApi by DeviceApiClient(context),
    FileApi by FileApiClient(context),
    PushApi by PushApiClient(context) {
    constructor(
        origin: HttpUrl,
        bearerToken: String? = null,
        client: OkHttpClient = OkHttpClient()
    ) : this(ApiContext(origin, bearerToken, client))

    constructor(
        origin: String,
        bearerToken: String? = null,
        client: OkHttpClient = OkHttpClient()
    ) : this(origin.toHttpUrl(), bearerToken, client)
}

internal class ApiContext(origin: HttpUrl, bearerToken: String?, client: OkHttpClient) {
    val requests = ApiRequestFactory(origin, bearerToken)
    val transfers = TransferRequestFactory(origin, bearerToken)
    val executor = HttpExecutor(client)
}
