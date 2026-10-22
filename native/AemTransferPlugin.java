package com.aem.store;

import android.app.Activity;
import android.content.Intent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AemTransfer")
public class AemTransferPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        try {
            String appearance = call.getString("appearance", "dark");
            Intent intent = new Intent(getContext(), AemTransferActivity.class);
            intent.putExtra("appearance", appearance);
            intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            if (!(getContext() instanceof Activity)) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to open AEM Transfer", error);
        }
    }
}
