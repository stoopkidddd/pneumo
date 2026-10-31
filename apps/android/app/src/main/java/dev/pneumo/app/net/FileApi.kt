package dev.pneumo.app.net

import dev.pneumo.app.protocol.CreateFileRequest
import dev.pneumo.app.protocol.CreateFileResponse
import dev.pneumo.app.protocol.DownloadTarget
import dev.pneumo.app.protocol.GetFileResponse
import dev.pneumo.app.protocol.UploadTarget
import okhttp3.RequestBody
import okhttp3.ResponseBody

interface FileApi {
    suspend fun createFile(request: CreateFileRequest): CreateFileResponse

    suspend fun uploadFileContent(fileId: String, body: RequestBody)

    suspend fun getFile(fileId: String): GetFileResponse

    suspend fun downloadFileContent(fileId: String): ResponseBody

    suspend fun uploadTo(target: UploadTarget, body: RequestBody)

    suspend fun downloadFrom(target: DownloadTarget): ResponseBody
}
