package com.aem.store;

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
            Intent i = new Intent(getContext(), AemTransferActivity.class);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Unable to open AEM Transfer", e);
        }
    }
}