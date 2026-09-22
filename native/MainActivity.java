package com.aem.store;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AemInstallerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
