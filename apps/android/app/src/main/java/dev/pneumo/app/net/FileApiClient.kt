package dev.pneumo.app.net

import dev.pneumo.app.protocol.CreateFileRequest
import dev.pneumo.app.protocol.CreateFileResponse
import dev.pneumo.app.protocol.DownloadTarget
import dev.pneumo.app.protocol.GetFileResponse
import dev.pneumo.app.protocol.UploadTarget
import okhttp3.RequestBody
import okhttp3.ResponseBody

internal class FileApiClient(private val context: ApiContext) : FileApi {
    override suspend fun createFile(request: CreateFileRequest): CreateFileResponse = context.executor.json(
        context.requests.authenticated(context.requests.apiUrl(ApiRequestFactory.FILES_PATH))
            .post(context.requests.jsonBody(CreateFileRequest.serializer(), request))
            .build(),
        CreateFileResponse.serializer(),
        HTTP_CREATED
    )

    override suspend fun uploadFileContent(fileId: String, body: RequestBody) {
        context.executor.empty(
            context.requests.authenticated(context.requests.fileContentUrl(fileId)).put(body).build(),
            HTTP_NO_CONTENT
        )
    }

    override suspend fun getFile(fileId: String): GetFileResponse = context.executor.json(
        context.requests.authenticated(context.requests.apiUrl(ApiRequestFactory.FILES_PATH, fileId))
            .get()
            .build(),
        GetFileResponse.serializer(),
        HTTP_OK
    )

    override suspend fun downloadFileContent(fileId: String): ResponseBody = context.executor.stream(
        context.requests.authenticated(context.requests.fileContentUrl(fileId)).get().build(),
        HTTP_OK
    )

    override suspend fun uploadTo(target: UploadTarget, body: RequestBody) {
        context.executor.transfer(context.transfers.upload(target, body)).close()
    }

    override suspend fun downloadFrom(target: DownloadTarget): ResponseBody =
        context.executor.transfer(context.transfers.download(target))

    companion object {
        private const val HTTP_OK = 200
        private const val HTTP_CREATED = 201
        private const val HTTP_NO_CONTENT = 204
    }
}
