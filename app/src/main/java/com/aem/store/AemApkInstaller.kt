package com.aem.store

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.content.pm.PackageInstaller
import java.io.BufferedInputStream

object AemApkInstaller {
    fun installUri(context: Context, uri: Uri): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return false
        }
        return try {
            val installer = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            if (Build.VERSION.SDK_INT >= 29) params.setPackageSource(PackageInstaller.PACKAGE_SOURCE_OTHER)
            val sessionId = installer.createSession(params)
            val session = installer.openSession(sessionId)
            try {
                context.contentResolver.openInputStream(uri).use { input ->
                    if (input == null) throw IllegalArgumentException("Cannot read APK")
                    BufferedInputStream(input).use { source ->
                        session.openWrite("base.apk", 0, -1).use { out ->
                            source.copyTo(out, 64 * 1024)
                            session.fsync(out)
                        }
                    }
                }
                val intent = Intent(context, InstallResultReceiver::class.java).setAction("com.aem.store.EXTERNAL_INSTALL")
                val pi = PendingIntent.getBroadcast(context, sessionId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                session.commit(pi.intentSender)
            } finally {
                session.close()
            }
            true
        } catch (_: Exception) { false }
    }
}